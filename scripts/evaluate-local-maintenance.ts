import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainRepository } from '../src/brain/repository.ts';
import { openPgliteBrainStore } from '../src/brain/store.ts';
import { OpenAiCompatibleGenerationProvider } from '../src/brain/providers.ts';
import { maintenanceScanHandler, maintenanceProposals } from '../src/brain/maintenance-scan.ts';
import { enqueueJob, runOneJob } from '../src/brain/jobs.ts';
const model = process.argv[2];
if (!model) throw new Error('Usage: bun run scripts/evaluate-local-maintenance.ts LOCAL_MODEL');
const fixture = 'Maya owns Juniper.';
const root = await mkdtemp(join(tmpdir(), 'manas-local-maintenance-'));
const repository = new BrainRepository(join(root, 'brain'));
const store = await openPgliteBrainStore(join(root, 'state'));
try {
 await repository.initialize();
 await repository.putPage('notes/assertion.md', fixture);
 const provider = new OpenAiCompatibleGenerationProvider(model, 'http://127.0.0.1:11434/v1/chat/completions', undefined, 'local', {}, {timeoutMs: 60000});
 const brainId = (await repository.getIdentity()).brainId;
 await enqueueJob(store, {type:'maintenance-scan',payload:{brainId}});
 const start = performance.now();
 const result = await runOneJob(store, 'local-evaluation', {'maintenance-scan':maintenanceScanHandler({repository,store,provider,workerId:'local-evaluation'})});
 const proposals = await maintenanceProposals(repository,{scope:'admin'});
 const findings = await store.query('SELECT findings,completed FROM brain_maintenance_analysis');
 const passed = result?.status === 'complete' && findings.length === 1 && findings[0]?.completed === true && proposals.items.some((item) => item.kind === 'fact-extraction' && item.evidence?.some((evidence) => evidence.text === fixture)) && proposals.items.some((item) => item.kind === 'relationship' && item.details && 'subject' in item.details && item.details.subject === 'Maya' && item.details.predicate === 'owns' && item.details.object === 'Juniper');
 const report = { version: 1, createdAt: new Date().toISOString(), model: provider.id, providerFingerprint: provider.fingerprint, fixture, latencyMs: Math.round(performance.now() - start), status: result?.status, findings, proposals: proposals.items.map((item) => ({ kind: item.kind, status: item.status, freshness: item.freshness, details: item.details, evidence: item.evidence?.map((evidence) => ({ text: evidence.text, startOffset: evidence.citation.startOffset, endOffset: evidence.citation.endOffset })) })), passed, limitations: 'One synthetic note. Production lease, extraction, proposal, and citation validation; not a broad extraction-quality estimate. No owner configuration, archives, or automatic managed writes.' };
 console.log(JSON.stringify(report, null, 2));
 if (!passed) process.exitCode = 1;
} finally {await store.close();await rm(root,{recursive:true,force:true});}
