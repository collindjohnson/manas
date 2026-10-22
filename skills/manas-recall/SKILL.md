---
name: manas-recall
description: Recall personal memories and search the authorized Manas brain when earlier decisions, preferences, or interactions are relevant.
---

Use the connected Manas MCP catalog. Call `memory.recall` with a concise query for persisted memories; use `retrieval.search` for conversations and documents. Both return authorized current evidence. Use `context.deliver` for a bounded context packet.

Cite the document ID, content revision, commit, and source span returned with the result. Preserve uncertainty and distinguish a recorded assertion from an independently verified fact. An empty result means no matching authorized evidence was found. Do not infer that the event never happened.

For CLI access use `manas recall --input '{"query":"...","limit":10}'`; the shared service or selected canonical brain supplies the runtime. Do not open the underlying database or bypass the service lock. If unavailable, continue the user's task with the available evidence and say recall was unavailable when relevant.
