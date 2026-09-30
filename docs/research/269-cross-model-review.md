# #269: does cross-model code review catch more than same-model review?

Research run 2026-09-30 for [#269](https://github.com/lcsmas/orchestra/issues/269)
(wayfinder map #266). Every source below was fetched with WebFetch on 2026-09-30.

- **VERIFIED** means the number was read on the fetched page (abstract, HTML body or vendor post).
  The fetch tool paraphrases, so quoted text is as returned by the tool and was not byte-checked
  against the page HTML.
- **UNVERIFIED** means the claim was seen only in a search summary or a secondary write-up.

## Verdict

Cross-model review catches more, but by a moderate amount and not symmetrically. The strongest
lever is still a separate, clean-context reviewer backed by an external oracle.

- **Gain size.** The one production-scale measurement (Greptile) shows **+8 to +10 pp recall** on
  high-severity bugs when the reviewer's vendor differs from the author's.
- **Direction matters.** The one controlled paper finds the benefit **asymmetric**: a weaker or
  mismatched reviewer can **break** correct code.
- **Same-vendor pairs stay correlated.** Errors correlate more within one vendor, and more as models
  get stronger. So Opus reviewing Sonnet is a weak form of diversity; the evidence for real
  diversity is cross-vendor.

## (a) Same-model blind spots and self-preference

| # | Claim | Source | Status |
|---|---|---|---|
| a1 | GPT-4 and Llama 2 can tell their own outputs apart from others "with non-trivial accuracy". Fine-tuning shows a **linear correlation** between self-recognition strength and self-preference strength. Evidence comes from summarisation, not code. | Panickssery, Bowman, Feng, [arXiv 2404.13076](https://arxiv.org/abs/2404.13076) (2024-04-15) | VERIFIED (abstract). The NeurIPS 2024 venue comes from the prior survey; UNVERIFIED this run. |
| a2 | **Code** (MBPP+). Most self-preference by strong judges is *legitimate*: legitimate self-preference ratio (LSPR) ≈ **81–89%** for Qwen2.5-72B and Llama-3.1-70B. When those judges are *wrong*, they still favour themselves, with harmful self-preference (HSPP) ≈ **50–75%**. Larger models show **more** harmful self-preference than smaller ones. Longer chain-of-thought gives the lowest HSPP. | Chen et al., "Do LLM Evaluators Prefer Themselves for a Reason?", [arXiv 2504.03846](https://arxiv.org/html/2504.03846v3) (v3 2025-12-12) | VERIFIED (HTML, via the fetch tool's summary of the tables) |
| a3 | **Code self-recognition is surface style.** 15 models, MBPP / HumanEval / DS-1000. Balanced accuracy at picking their own solution is **49–58% (chance level)**. Stripping docstrings, comments, type hints and names pushes most pairs to chance. | Barkhordar & Thapa, "Style, Not Self", [arXiv 2609.30048](https://arxiv.org/abs/2609.30048) (2026-09-24) | VERIFIED (abstract) |
| a4 | Same-family judge lift of **+3.4 to +8.4 pp**. Four open-weight families, 9,312 fully crossed pairwise judgments. | Awuni et al., [arXiv 2609.17857](https://arxiv.org/abs/2609.17857) (2026-09-15) | VERIFIED (abstract). Not code-specific. |
| a5 | **Correlated errors.** Over 350 LLMs: when both models err, they agree on the same wrong answer **60%** of the time on HELM (random baseline 1/3) and **0.423** on HF (random 0.127). The same company, same architecture and higher accuracy of *both* models each raise agreement; the accuracy×accuracy interaction is positive on all three datasets. Judges "inflate the accuracy of models that are less accurate than itself, especially models from the same provider". | Kim, Garg, Peng, Garg, [arXiv 2506.07962](https://arxiv.org/html/2506.07962) (ICML 2025) | VERIFIED (abstract + HTML) |
| a6 | "LLM-as-a-judge scores favor models similar to the judge"; "model mistakes are becoming more similar with increasing capabilities". | Goel et al., "Great Models Think Alike…", [arXiv 2502.04313](https://arxiv.org/abs/2502.04313) (rev. 2025-06-12) | VERIFIED (abstract) |
| a7 | Greater "generative-process diversity" between two models goes with less correlated failure. 38 models, 10 benchmark families, partial rank association **−0.216** (95% CI −0.309 to −0.122). | Tieman & Markou, [arXiv 2609.03422](https://arxiv.org/abs/2609.03422) (2026-09-03) | VERIFIED (abstract) |
| a8 | Without external feedback, "LLMs struggle to self-correct … at times, their performance even degrades". | Huang et al., [arXiv 2310.01798](https://arxiv.org/abs/2310.01798) (ICLR 2024) | VERIFIED (abstract) |
| a9 | Self-evaluating agents "confidently prais[e] the work". "Tuning a standalone evaluator to be skeptical turns out to be far more tractable than making a generator critical of its own work." The evaluator and generator were the same Claude model: Opus 4.5, later 4.6. | Anthropic, [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) (2026-03-24) | VERIFIED (post). The same-model detail is the fetch tool's reading and is not stated in one explicit sentence. |
| a10 | "Putting the same model in two agents … does not quite make them self-biased/correlated in the same way you might imagine one human doing both tasks would be". Clean context is the lever. | Cognition, [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working) (2026-04-22) | VERIFIED (post) |

How to read (a):

- **The bias is real but not about the model.** Self-preference exists, but a large part of it
  is justified by the output actually being better (a2).
- **Self-recognition on code is shallow.** It rides on style cues (a3), so a clean-context
  reviewer that is the same model does not "know" it wrote the diff.
- **The bigger risk is shared blind spots.** Correlated errors (a5–a7) grow with capability and
  are highest within one provider. A different Claude tier does not escape this.

## (b) Cross-model catch-rate evidence (code)

| # | Claim | Source | Status |
|---|---|---|---|
| b1 | **Production PRs, cross-vendor.** Recall on high-severity bugs over two sets of 500 PRs each (~1,500 ground-truth bug comments; ground truth from reactions and git archaeology). Authors: Claude Opus 4.7 vs GPT 5.5 (Codex). Claude reviewing Claude: **53.7%**. GPT reviewing Claude: **62.0%**. Claude reviewing GPT: **60.0%**. GPT reviewing GPT: **50.5%**. "Both models find more bugs in code written by the other model." Each tool's `/review` was run 3× per PR. No CIs, no p-values, no false-positive rate. | Greptile, [Models are worse at reviewing their own code](https://www.greptile.com/blog/model-inversion) (2026-07-21) | VERIFIED (post). A vendor study, not peer-reviewed. |
| b2 | **Same study, behaviour.** Opus posts 7–8 comments per review; GPT posts 1–2. GPT "tunnels": it finds bugs while reasoning but omits them from the review. A prompt asking for "around 7 to 10 comments" recovered part of that. | same | VERIFIED |
| b3 | **Controlled experiment.** 116 hard/medium LiveCodeBench tasks, claude-opus-4-7 (Claude Code 2.1.50) vs gpt-5.5 (Codex CLI), effort high. The reviewer sees the draft but **cannot run tests**. Claude reviewing Codex: 71.6% → **89.7%** (p_BH=.001). Codex self-review: → **84.5%** (p=.022). Codex reviewing Claude: 91.4% → **82.8%** (p=.046, harmful). Claude self-review: 91.4% **unchanged**. Fixes/regressions: Claude reviewing Codex 26/5; Codex self-review 21/6; Codex reviewing Claude **3/13**; Claude self-review 3/3. | Xiang, Zhang, Zhang, Xu, [arXiv 2607.21656](https://arxiv.org/html/2607.21656) (2026-07-22) | VERIFIED (abstract + HTML tables) |
| b4 | **Reading b3.** The gain comes from a *stronger or complementary* reviewer. Cross-vendor alone is not the cause: the weaker-on-this-task reviewer regressed the stronger author's code. Self-review by the strong model was neutral, not harmful. The authors did not measure rewrite frequency. | same | VERIFIED |
| b5 | A panel of smaller models from **disjoint families** (PoLL) beats a single GPT-4 judge across 3 settings and 6 datasets, with "less intra-model bias", at **>7× lower cost**. Not code review. | Verga et al., [arXiv 2404.18796](https://arxiv.org/abs/2404.18796) (2024) | VERIFIED (abstract) |
| b6 | "Multi-review aggregation" raises code-review F1 by **up to 43.67%**. The abstract does not say whether the reviews come from different models or repeated samples. | SWR-Bench, [arXiv 2509.01494](https://arxiv.org/abs/2509.01494) (rev. 2026-06-05) | VERIFIED number; cross-model vs same-model UNVERIFIED |
| b7 | RL-trained critics: model critiques were preferred over human critiques in **63%** of naturally occurring bugs. Critics hallucinate bugs; human+critic teams cut false positives. | McAleese et al. (OpenAI), [arXiv 2407.00215](https://arxiv.org/abs/2407.00215) (2024) | VERIFIED (abstract) |
| b8 | Pooled verifiers "broke 33.9% of submissions written by a model of their own family and 34.3% of everyone else's", i.e. no family effect. | search-engine summary only. The primary source was not located (checked arXiv 2609.01345 and 2602.12670: ABSENT). | **UNVERIFIED — do not cite** |
| b9 | Secondary claims that "iterative multi-model review catches 3–5× more bugs" (zylos.ai, mindstudio.ai). | secondary blogs | **UNVERIFIED — no primary data** |

How to read (b):

- There is exactly **one production-scale data point** (b1, a vendor study without error bars)
  and **one controlled study** (b3, 116 algorithmic tasks, no repo context, no test execution).
- Both are cross-*vendor*, Claude vs GPT. **No primary evidence was found for cross-*tier*
  same-vendor review** (Opus reviewing Sonnet) on code.

## (c) Production setups

| # | Setup | Source | Status |
|---|---|---|---|
| c1 | **Greptile "model inversion"** is shipped as experimental: "If Claude wrote it, GPT reviews it, and vice versa". Greptile v3 is reported to run on the Claude Agent SDK. | [Greptile post](https://www.greptile.com/blog/model-inversion) | inversion VERIFIED; the Agent SDK detail is UNVERIFIED (secondary comparison sites) |
| c2 | **Anthropic Claude Code Review** runs multiple parallel agents, each on a different issue class. A **verification step** then "checks candidates against actual code behavior to filter out false positives", followed by dedupe and severity ranking. Numbers: PRs with substantive comments went 16% → **54%**. Large PRs (>1,000 lines): 84% get findings, avg 7.5. Small PRs (<50 lines): 31%, avg 0.5. **<1%** of findings marked incorrect. ~20 min per review. The model is not disclosed, and the reviewer is Claude whatever the author was. | [claude.com/blog/code-review](https://claude.com/blog/code-review) (2026-03-09); [docs](https://code.claude.com/docs/en/code-review) | VERIFIED |
| c3 | **Cursor Bugbot** runs 8 parallel passes with **randomized diff order**, then majority voting (drops bugs found by only one pass), then a **validator model** to catch false positives, then dedupe against earlier runs. Resolution rate went 52% → >70% over 40 experiments; 0.4–0.7 bugs flagged per run. Diversity comes from sampling and ordering, not from model vendor. The model is not named in the post. | [cursor.com/blog/building-bugbot](https://cursor.com/blog/building-bugbot) | VERIFIED. The "Composer 2.5 powers Bugbot, 22% cheaper" figure is UNVERIFIED (secondary). |
| c4 | **OpenAI Codex reviewer**: "The Codex code generator and code reviewer are the same model", trained with different methods. They monitor whether it games its own checks and report "the reviewer remains similarly effective" on Codex-written vs human code. Authors address 52.7% of comments with a code change; >100k external PRs/day; >80% positive reactions. It is tuned for precision over recall. | OpenAI, [A Practical Approach to Verifying Code at Scale](https://alignment.openai.com/scaling-code-verification/) (2025-12-01) | VERIFIED |
| c5 | **Cognition Devin Review** uses the same model in a clean context: ~**2 bugs/PR**, ~**58%** severe. | [Cognition post](https://cognition.com/blog/multi-agents-working) | VERIFIED |

How to read (c):

- **Only Greptile ships author≠reviewer as a rule.** The three largest first-party reviewers
  (Anthropic, OpenAI, Cognition) review with their own model.
- **Their lever is structure instead.** They rely on clean context, a skeptical prompt,
  multi-pass voting and a separate verification/validator step.

## (d) Cost

| # | Figure | Source | Status |
|---|---|---|---|
| d1 | Per task: solo Codex $0.190 / 38.5 s, solo Claude $0.226 / 86.2 s. Claude reviewing Codex $0.443 / 112 s. Codex reviewing Claude $0.382 / 118 s. Codex self-review $0.312 / 68 s. Claude self-review $0.389 / 136 s. A review step adds **~$0.12–0.25 and 29–74 s** per task. | [arXiv 2607.21656](https://arxiv.org/html/2607.21656) Table 2 | VERIFIED |
| d2 | Claude Code Review costs **$15–25 per review** on average, token-billed, ~20 min; the per-push trigger multiplies it. | [docs](https://code.claude.com/docs/en/code-review) | VERIFIED |
| d3 | PoLL panel of diverse small judges costs **>7× less** than a single GPT-4 judge. | [arXiv 2404.18796](https://arxiv.org/abs/2404.18796) | VERIFIED |
| d4 | Anthropic harness: solo 20 min / $9 vs generator+evaluator harness 6 h / $200; V2 3 h 50 min / $124.70. | [harness post](https://www.anthropic.com/engineering/harness-design-long-running-apps) | VERIFIED |
| d5 | Greptile gives **no cost figure** for model inversion. | [Greptile post](https://www.greptile.com/blog/model-inversion) | VERIFIED (absence on that page) |

- **Hidden cost of cross-vendor review:** a second vendor account or API key, a second CLI or
  harness (`codex` vs `claude`), and output styles that differ (b2: 1–2 vs 7–8 comments). The
  prompt would have to be calibrated per reviewer model.

## Implications for Orchestra

Current state (per #269/#266): authors run Sonnet 5.5 at effort xhigh, and the pre-review
subagent and the adversarial reviewer **inherit the same model**.

1. **Keep the clean-context, separate reviewer. It is the best-supported lever.**
   - Anthropic, OpenAI and Cognition all get production value from a same-model reviewer (a9,
     a10, c2, c4, c5).
   - Code self-recognition is style-deep (a3), so a fresh-context Sonnet reviewer has little
     "own work" bias to exploit.
2. **A tier change inside Anthropic (Opus reviewing Sonnet) is a capability bet, not a diversity bet.**
   - b3 says the gain comes from a stronger or complementary reviewer. A weaker one regresses
     correct code (3 fixes / 13 regressions).
   - Same-provider errors stay correlated (a5, a6).
   - Therefore: an Opus adversarial reviewer on Sonnet diffs is plausible on capability grounds,
     but there is **no primary code evidence** for it. Measure it before adopting (step 5).
3. **Cross-vendor review is the only arm with direct catch-rate evidence (+8 to +10 pp recall, b1).**
   - It is one vendor study, with no false-positive rate and no CIs.
   - It needs a second vendor account plus a harness that can spawn a non-Claude reviewer, which
     Orchestra does not have today.
   - Treat it as an **opt-in extra reviewer seat** on high-risk diffs, not a replacement.
4. **Cheaper diversity is available now, with no new vendor.**
   - Bugbot-style passes: N passes with randomized diff order, majority vote, then a validator
     pass (c3).
   - Anthropic-style split: finder agents per issue class plus a separate verification step (c2).
   - Both attack correlated misses and false positives without a second vendor.
5. **Measure before switching.** Orchestra already has the ingredients:
   - labelled findings from the ledger reviews (#224, #234, #237);
   - mutation gates as ground truth.
   - A cheap A/B: replay K merged candidates that had **known** review findings or surviving
     mutants through (i) Sonnet-xhigh clean context (current), (ii) Opus, (iii) a non-Claude
     reviewer if a key exists.
   - Count recall on the known findings plus false positives. The must-FAIL arm is a reviewer on
     a diff with a reintroduced known bug.
   - b3's regression column says to track **harm** (a reviewer "fixing" correct code), not only
     catches.
6. **The external oracle remains primary.**
   - Every source agrees that LLM review without execution is weaker: a8; b3's reviewers could
     not run tests; c2's verification step checks "actual code behavior".
   - Mutation and build gates stay the gate. Model choice for the reviewer is a second-order knob.

## NOT VERIFIED / gaps

- No primary study of **same-vendor cross-tier** code review (Opus vs Sonnet, Sonnet vs Haiku).
- **False-positive rate** of cross- vs same-model review. Greptile gives none; b3 gives
  regressions, not comment-level FP.
- Whether SWR-Bench's +43.67% aggregation is multi-model or multi-sample (b6).
- The b8 "33.9% vs 34.3%" family-neutral verifier figure: primary source not found.
- The models behind Claude Code Review and Bugbot (not disclosed on the fetched pages).
- Greptile's reviewer harness details, and whether the effect survives model updates (Greptile
  itself calls it "experimental").
- Panickssery et al. NeurIPS 2024 acceptance was not re-checked this run.
