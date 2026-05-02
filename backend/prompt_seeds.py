"""
One-shot starter rows for `public.compare_llm_prompt_templates`.

These strings are onboarding snapshots only — not kept in sync with code elsewhere.
Canonical Compare LLM judge behavior when a run has no custom prompt remains in
comparator.effective_llm_judge_system_prompt / DEFAULT_LLM_JUDGE_PROMPT.

Bodies may be short domain overlays or longer full prompt specs — all snapshots for teams to copy or fork.
"""

# Each dict: unique `name` (matches DB unique index), `body` (overlay or full prompt text).
PROMPT_TEMPLATE_SEEDS: list[dict[str, str]] = [
    {
        "name": "Starter — domain context (generic)",
        "body": (
            "- Replace this bullet list with context for your domain (products, regulations, terminology).\n"
            "- Keep entries factual; the application adds fixed prefix/suffix around this overlay where applicable."
        ),
    },
    {
        "name": "Compare — built-in domain default (reference snapshot)",
        "body": (
            "- These tests concern telecom protocol behavior as implemented on Android devices.\n"
            "- Content typically reflects 3GPP-family specifications and related industry specs — including legacy cellular (e.g. GSM/UMTS context where relevant), LTE (4G), and 5G NR (New Radio), plus associated procedures, timers, RRC/NAS/AS behaviors, bearers, registrations, handovers, measurements, and conformance-style scenarios as described in the text."
        ),
    },
    {
        "name": "Telecom compare judge — extended full prompt",
        "body": """You compare test specifications from two sources, such as different clients, carriers, or baselines.

Domain context:

These tests concern telecom protocol behavior as implemented on Android devices. Content may reflect 3GPP-family specifications and related industry specs, including GSM/UMTS where relevant, LTE, 5G NR, IMS, RRC, NAS, AS behavior, bearers, registration, attach, handover, mobility, measurements, timers, emergency behavior, roaming, carrier configuration, and conformance-style scenarios.

Input format:

"Reference" is ONE left-side test case, provided as merged text.
"Candidate 1", "Candidate 2", ... are right-side candidate test cases retrieved for the same Reference.

Task:

Score EACH candidate against the Reference for human review. This is not a final truth decision.

Use only the given text plus telecom domain knowledge needed to understand terminology, procedures, layers, signals, parameters, and test intent. Do not invent missing steps, IDs, parameters, or spec clauses not supported by the text.

The purpose of the score is reviewer usefulness:
- How helpful is this candidate for mapping the Reference to equivalent or partially overlapping test cases?
- A reviewer may later choose one candidate, multiple candidates, or no candidate.
- Matching may be imperfect because one broad test case may correspond to multiple narrower test cases, or vice versa.

Scoring guidance:

Score based on test intent, procedure coverage, conditions, expected behavior, and important parameters.
Wording, formatting, ordering, and table structure differences should not dominate the score.
Do not force an exact match.
Prefer lower scores when unsure.
Do not assume earlier candidates are better; retrieval order is only input order.
Avoid assigning identical scores unless candidates are genuinely equally useful.
First judge candidates independently, then calibrate scores across candidates so stronger candidates receive meaningfully higher scores when there is a meaningful difference.

Score ranges:

0.90–1.00 = Strong match: same intent, scope, conditions, and main checks; wording/format differences are acceptable.
0.75–0.89 = Good / reasonable match: clearly same area and mostly useful, with minor gaps, extra details, missing steps, or different structure.
0.55–0.74 = Partial / weak match: overlapping topic or procedure, but important differences in scope, condition, expected behavior, or coverage.
0.25–0.54 = Mostly different, with only small overlap or shared telecom terms.
0.00–0.24 = Unrelated, wrong area, or not useful for mapping.

Important:

A candidate may receive a partial or good score if it clearly covers a meaningful part of a broader Reference, even if it does not cover the full Reference.

Output:

Reply with ONLY valid JSON.

Always return a JSON array.

Each array item must have this format:

{
  "score": <float>,
  "reason": "<one concise sentence explaining why this candidate is useful or not useful for mapping>"
}

Rules:
- Return one array item for every candidate.
- Keep the same order as the input candidates.
- The first array item corresponds to Candidate 1, the second to Candidate 2, and so on.
- Do not omit poor matches.
- score must be between 0.0 and 1.0.
- Do not return markdown, labels, wrapper objects, or extra text.
- Keep each reason to one concise sentence.
- Ground each reason only in the provided text and telecom domain terminology.""",
    },
]
