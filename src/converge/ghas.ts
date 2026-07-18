/**
 * The GHAS / repo-security + merge-button settings-convergence step
 * (issue #15). Pure API mutations — no files, no PR. Reads the current
 * state via {@link RepoSettingsClient.readSettings} and writes only
 * what differs, so a converged repo produces zero mutations on a
 * repeat sweep.
 *
 * Independent-concern error posture: each setting is converged and
 * reported on its own. A failed setting (report-and-skip on a 422
 * entitlement error, or report-and-continue on some other non-ok
 * response) does not stop the remaining settings for that repo — this
 * mirrors issue #15's "Constraints / decisions" section. Only an
 * *unexpected* error (a thrown network/parse error, or an unexpected
 * non-ok/non-422 status from a write) propagates, so the sweep's
 * per-repo try/catch can record that repo as `failed`.
 */
import type { RepoSettingsClient } from "../github/settings.js";

/** One setting's outcome for a single repo. */
export type SettingOutcome = "changed" | "already-converged" | "skipped";

/** Per-setting result, keyed by a short human-readable name. */
export interface SettingResult {
  readonly setting: string;
  readonly outcome: SettingOutcome;
  /** Why it was skipped (entitlement 422, unavailable endpoint, etc). */
  readonly reason?: string;
}

/** Full result of converging one repo's GHAS + merge-button settings. */
export interface GhasConvergeResult {
  readonly results: readonly SettingResult[];
  /**
   * `true` when every setting was already-converged — i.e. no
   * drift-correcting write was needed. The push-protection-bypass
   * enablement is the one exception: GitHub exposes no stable per-repo
   * `GET` for its current state (per the issue's own constraint), so
   * that one call is always attempted best-effort on every converge
   * pass and always reports `changed` on success — its own outcome
   * does not gate `noop`.
   */
  readonly noop: boolean;
}

const SETTING_NAMES = {
  vulnerabilityAlerts: "vulnerability-alerts",
  automatedSecurityFixes: "automated-security-fixes",
  secretScanning: "secret-scanning",
  secretScanningPushProtection: "secret-scanning-push-protection",
  pushProtectionBypass: "push-protection-delegated-bypass",
  mergeButton: "merge-button-settings",
} as const;

/**
 * Converge one repo's GHAS / repo-security toggles and merge-button /
 * PR-hygiene settings.
 *
 * @param client the settings client (already authenticated).
 * @param owner the target repo's owner (org/user).
 * @param repo the target repo's name (without owner).
 * @param dryRun when `true`, decide and report diffs without writing.
 */
export async function convergeGhasSettings(
  client: RepoSettingsClient,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<GhasConvergeResult> {
  const current = await client.readSettings(owner, repo);
  const results: SettingResult[] = [];

  // Dependabot alerts.
  if (current.vulnerabilityAlertsEnabled) {
    results.push({ setting: SETTING_NAMES.vulnerabilityAlerts, outcome: "already-converged" });
  } else if (dryRun) {
    results.push({ setting: SETTING_NAMES.vulnerabilityAlerts, outcome: "changed" });
  } else {
    const res = await client.enableVulnerabilityAlerts(owner, repo);
    results.push(outcomeFromResponse(SETTING_NAMES.vulnerabilityAlerts, res));
  }

  // Dependabot security updates (enablement only).
  if (current.automatedSecurityFixesEnabled) {
    results.push({ setting: SETTING_NAMES.automatedSecurityFixes, outcome: "already-converged" });
  } else if (dryRun) {
    results.push({ setting: SETTING_NAMES.automatedSecurityFixes, outcome: "changed" });
  } else {
    const res = await client.enableAutomatedSecurityFixes(owner, repo);
    results.push(outcomeFromResponse(SETTING_NAMES.automatedSecurityFixes, res));
  }

  // Secret scanning + push protection — PATCH only the sub-keys that
  // differ from the current security_and_analysis block.
  const secretScanningPatch: {
    secretScanning?: boolean;
    secretScanningPushProtection?: boolean;
  } = {};
  if (current.secretScanning !== "enabled") {
    secretScanningPatch.secretScanning = true;
  }
  if (current.secretScanningPushProtection !== "enabled") {
    secretScanningPatch.secretScanningPushProtection = true;
  }
  if (Object.keys(secretScanningPatch).length === 0) {
    results.push({ setting: SETTING_NAMES.secretScanning, outcome: "already-converged" });
    results.push({
      setting: SETTING_NAMES.secretScanningPushProtection,
      outcome: "already-converged",
    });
  } else if (dryRun) {
    if (secretScanningPatch.secretScanning !== undefined) {
      results.push({ setting: SETTING_NAMES.secretScanning, outcome: "changed" });
    } else {
      results.push({ setting: SETTING_NAMES.secretScanning, outcome: "already-converged" });
    }
    if (secretScanningPatch.secretScanningPushProtection !== undefined) {
      results.push({
        setting: SETTING_NAMES.secretScanningPushProtection,
        outcome: "changed",
      });
    } else {
      results.push({
        setting: SETTING_NAMES.secretScanningPushProtection,
        outcome: "already-converged",
      });
    }
  } else {
    const res = await client.patchSecurityAndAnalysis(owner, repo, secretScanningPatch);
    const outcome = outcomeFromResponse("secret-scanning-and-push-protection", res);
    if (secretScanningPatch.secretScanning !== undefined) {
      results.push({ ...outcome, setting: SETTING_NAMES.secretScanning });
    } else {
      results.push({ setting: SETTING_NAMES.secretScanning, outcome: "already-converged" });
    }
    if (secretScanningPatch.secretScanningPushProtection !== undefined) {
      results.push({ ...outcome, setting: SETTING_NAMES.secretScanningPushProtection });
    } else {
      results.push({
        setting: SETTING_NAMES.secretScanningPushProtection,
        outcome: "already-converged",
      });
    }
  }

  // Push-protection bypass lockdown — best-effort, never a hard
  // failure. Mirrors the `gh-repo-setup-protection` skill's posture:
  // attempt the delegated-bypass enablement and surface the residual
  // manual step honestly rather than inventing a stable "nobody" toggle.
  if (dryRun) {
    results.push({ setting: SETTING_NAMES.pushProtectionBypass, outcome: "changed" });
  } else {
    const res = await client.enableSecretScanningDelegatedBypass(owner, repo);
    if (res.ok) {
      results.push({ setting: SETTING_NAMES.pushProtectionBypass, outcome: "changed" });
    } else {
      results.push({
        setting: SETTING_NAMES.pushProtectionBypass,
        outcome: "skipped",
        reason:
          `delegated bypass enablement unavailable (${res.status}) — configure ` +
          `"who can bypass" = nobody in the repo's Code security settings ` +
          "(no stable public REST toggle)",
      });
    }
  }

  // Merge button / PR-hygiene settings.
  const mergeButtonPatch: {
    allowMergeCommit?: boolean;
    allowSquashMerge?: boolean;
    allowRebaseMerge?: boolean;
    allowAutoMerge?: boolean;
    deleteBranchOnMerge?: boolean;
  } = {};
  if (!current.allowMergeCommit) {
    mergeButtonPatch.allowMergeCommit = true;
  }
  if (current.allowSquashMerge) {
    mergeButtonPatch.allowSquashMerge = false;
  }
  if (current.allowRebaseMerge) {
    mergeButtonPatch.allowRebaseMerge = false;
  }
  if (!current.allowAutoMerge) {
    mergeButtonPatch.allowAutoMerge = true;
  }
  if (!current.deleteBranchOnMerge) {
    mergeButtonPatch.deleteBranchOnMerge = true;
  }
  if (Object.keys(mergeButtonPatch).length === 0) {
    results.push({ setting: SETTING_NAMES.mergeButton, outcome: "already-converged" });
  } else if (dryRun) {
    results.push({ setting: SETTING_NAMES.mergeButton, outcome: "changed" });
  } else {
    const res = await client.patchMergeButtonSettings(owner, repo, mergeButtonPatch);
    results.push(outcomeFromResponse(SETTING_NAMES.mergeButton, res));
  }

  // The push-protection-bypass setting is excluded from the `noop`
  // calculation: it is always attempted best-effort (no stable read of
  // its current state exists) and always reports `changed` on success,
  // so including it would make `noop` false on every single converge
  // pass, defeating its purpose as "nothing else needed correcting."
  const noopEligible = results.filter(
    (r) => r.setting !== SETTING_NAMES.pushProtectionBypass,
  );
  return {
    results,
    noop: noopEligible.every((r) => r.outcome === "already-converged"),
  };
}

/**
 * Map a write response to a {@link SettingResult}'s outcome/reason.
 *
 * - 2xx -> `changed`.
 * - 422 -> `skipped` (entitlement — GHAS features unavailable on an
 *   unentitled private repo). Not a sweep failure.
 * - any other non-ok -> throws, so the caller's per-repo try/catch (in
 *   `sweep.ts`) records this repo as `failed` rather than silently
 *   swallowing an unexpected error.
 */
function outcomeFromResponse(setting: string, res: Response): SettingResult {
  if (res.ok) {
    return { setting, outcome: "changed" };
  }
  if (res.status === 422) {
    return {
      setting,
      outcome: "skipped",
      reason: `entitlement required (422) — feature unavailable on this repo`,
    };
  }
  throw new Error(`Failed to write ${setting}: ${res.status} ${res.statusText}`);
}
