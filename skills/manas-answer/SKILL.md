---
name: manas-answer
description: Answer a personal-brain question through configured local Manas generation with verified citations and explicit evidence gaps.
---

Call `reasoning.answer` with the question. Manas retrieves current authorized evidence, invokes the configured local generation provider, and checks its citations. Use the returned outcome, answer, citations, and knowledgeGaps together.

For insufficient_evidence, explain the evidence gap. For local_model_not_configured, report the suggested local-model setup fix; do not route the evidence to a hosted model or a shell-based generation fallback. For grounding_failed, do not present the rejected answer as supported.

Cite the returned document ID, revision, commit, and span near factual claims. If evidence conflicts, preserve the conflict instead of choosing an unsupported assertion. Generated answers are derived results and must not be captured as independent primary facts.

CLI access is `manas operation reasoning.answer --input '{"question":"..."}'` with the configured brain/service.
