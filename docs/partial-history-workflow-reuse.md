# Partial-history workflow identity correction

## Observed failure

After 0.15.3, three saved Draken implementation definitions differed mainly because particular excerpts omitted validation, documentation or stored-data checks. The matcher received the existing definitions but treated missing observations as different required endpoints. The failed enrichment was a separate validator failure; removing that limit did not repair the catalog.

While this correction was being prepared, the still-running old matcher created another definition (`768fc7cb3520…`) from the current partial work. Its reason again rejected existing implementation definitions because their later stages were not observed. This is direct evidence of the recurrence, not evidence that the new prompt works.

## Code changes

- Matching explicitly distinguishes the intended procedure from the intersection of visible steps. Missing later stages are observation gaps, not evidence of an edits-only endpoint.
- Prefer a compatible supplied identity. A new identity requires positive evidence of a material difference, not merely missing observations. Where the intended identity cannot be established, return the existing `insufficient` outcome rather than a competing definition.
- Preserve genuinely different explicit endpoints, specialized techniques and the rejection of feature-specific definitions.
- Accept earlier comparison recipe hashes so the prompt change does not invalidate existing discoveries or guidance.
- Preserve saved aliases when preparation refreshes presentation. No page-time inference or provenance reads were added.

## Catalog repair

The owner requested correction of the visible duplicates. Reuse the existing Ready implementation-and-validation identity `779e00302c17…`; do not generate another definition or enrichment. Link duplicate IDs using the existing consolidation-members table and saved aliases. Keep historical discoveries, comparison responses, enrichments, failures, accounting and execution records unchanged. Keep the local-deployment workflow separate.

The private repair script first tests the same transaction on a database copy, waits for preparation to be idle, backs up the live database, and applies only alias/display metadata changes. No model calls or original-session reads are required. This is an explicit repair, not an automatic startup migration or a page-read side effect.

## Qualification and limits

910 unit tests, typechecks and Knip passed in an isolated checkout. Tests cover partial evidence reusing a complete definition without inventing observed stage citations, uncertain identity remaining a non-discovery, old receipts remaining usable without regeneration, and alias preservation. Existing permission, cancellation, accounting and failed-attempt retention tests remain.

These tests exercise contracts and mocked provider responses. They do not prove the model will follow the revised identity instructions. Real-model evaluation of the saved failing comparisons and explicit different-endpoint controls needs a separately authorized allowance; previous evaluation allowances are exhausted. No paid evaluation or automatic replay was performed for this change.
