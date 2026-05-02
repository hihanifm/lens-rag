"""
One-shot starter rows for `public.compare_llm_prompt_templates`.

These strings are onboarding snapshots only — not kept in sync with code elsewhere.
Canonical Compare LLM judge behavior when a run has no custom prompt remains in
comparator.effective_llm_judge_system_prompt / DEFAULT_LLM_JUDGE_PROMPT.
"""

# Each dict: unique `name` (matches DB unique index), `body` (domain-overlay style text).
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
]
