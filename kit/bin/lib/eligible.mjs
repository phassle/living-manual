// Which scenarios get a video (spec: Video: "one video per confirmed scenario"). The one place
// that decides it: the scenario's last run passed, and the writer's confirmation holds (the
// confirmation model, bin/lib/confirmation.mjs: confirmed, fingerprint still matching).
import { scenarioState } from './confirmation.mjs';

/** { eligible, reason } for a scenario's step record in a product folder. */
export function videoEligible(record, folder) {
	const id = record.scenario?.id ?? '?';
	if (record.run?.status !== 'passed') return { eligible: false, reason: `${id}: its last run did not pass (${record.run?.status ?? 'no status'}); run it again with lm-run first` };
	const state = scenarioState(folder, id);
	if (state.status !== 'confirmed') return { eligible: false, reason: `${id}: ${state.status} (${state.reason}); only a scenario the writer has confirmed gets a video` };
	return { eligible: true, reason: `${id}: last run passed; ${state.reason}` };
}
