import type {
  DiscussionTopic,
  PolicyCategory,
  PolicyOutcome,
} from "./contracts";

export const SAFE_TOPIC_ALTERNATIVE =
  "Choose a Topic that critically examines prevention, history, consequences, or human rights without praising extremists or advocating harm.";
export const SAFE_OUTPUT_ALTERNATIVE =
  "Start a new Discussion with a different permitted Topic; the blocked Turn was not added to the Transcript.";

interface ProhibitedCategoryRule {
  category: PolicyCategory;
  matches(text: string): boolean;
}

const EXPLICIT_ADVOCACY =
  /\b(?:advocat(?:e|es|ed|ing)|argu(?:e|es|ed|ing)\s+(?:for|that)|call(?:s|ed|ing)?\s+for|case\s+for|in\s+favou?r\s+of|celebrat(?:e|es|ed|ing)|defend(?:s|ed|ing)?|demand(?:s|ed|ing)?|encourag(?:e|es|ed|ing)|endors(?:e|es|ed|ing)|glorif(?:y|ies|ied|ying)|justif(?:y|ies|ied|ying)|prais(?:e|es|ed|ing)|promot(?:e|es|ed|ing)|support(?:s|ed|ing)?|urg(?:e|es|ed|ing))\b/u;
const HARM_APPROVAL =
  /\b(?:acceptable|advantageous|advantages?|beneficial|benefits?|desir(?:able|ed)|deserv(?:e|es|ed)|good|justified|laudable|moral|necessary|okay|positive|praiseworthy|preferable|right|warranted|worthwhile)\b/u;
const VIOLENCE =
  /\b(?:assault(?:s|ed|ing)?|attack(?:s|ed|ing)?|beat(?:s|en|ing)?|bomb(?:s|ed|ing)?|death|destroy(?:s|ed|ing)?|die|eliminat(?:e|es|ed|ing|ion)|eradicat(?:e|es|ed|ing|ion)|exterminat(?:e|es|ed|ing|ion)|harm(?:s|ed|ing)?|kill(?:s|ed|ing)?|lynch(?:es|ed|ing)?|massacr(?:e|es|ed|ing)|murder(?:s|ed|ing)?|shoot(?:s|ing)?|slaughter(?:s|ed|ing)?|tortur(?:e|es|ed|ing)|violence|violent|wipe(?:s|d|ing)?\s+out)\b/u;
const DIRECT_VIOLENCE_DEFENSE = new RegExp(
  `\\bdefen[cs]e\\s+of\\s+(?:the\\s+)?${VIOLENCE.source}`,
  "u",
);
const PROTECTED_CLASS =
  /\b(?:protected[- ]class(?:es)?|racial|race|ethnic(?:ity)?|religious|religion|nationality|sexual orientation|gender identity|women|woman|men|man|gay|lesbian|bisexual|transgender|disabled|disability|people with disabilities|black people|white people|asian people|latinos?|latinas?|arabs?|indigenous people|native americans?|jews?|jewish|muslims?|christians?|hindus?|sikhs?)\b/u;
const PRESCRIPTIVE_VIOLENCE =
  /\b(?:should|must|ought\s+to|deserve(?:s|d)?\s+to)\s+(?:all\s+)?(?:be\s+)?(?:assault(?:ed)?|attack(?:ed)?|beat(?:en)?|bomb(?:ed)?|destroy(?:ed)?|die|eliminat(?:e|ed)|eradicat(?:e|ed)|exterminat(?:e|ed)|harm(?:ed)?|kill(?:ed)?|lynch(?:ed)?|massacr(?:e|ed)|murder(?:ed)?|shoot|slaughter(?:ed)?|tortur(?:e|ed)|wipe(?:d)?\s+out)\b/u;
const DIRECT_VIOLENCE_ADVOCACY =
  /(?:^|[.!?]\s*)(?:assault|attack|beat|bomb|destroy|eliminate|eradicate|exterminate|harm|kill|lynch|massacre|murder|shoot|slaughter|torture|wipe\s+out)\b|(?:^|[.!?]\s*)death\s+to\b/u;

const GENOCIDE = /\b(?:genocide|ethnic cleansing)\b/u;
const DIRECT_GENOCIDE_DEFENSE =
  /\bdefen[cs]e\s+of\s+(?:genocide|ethnic cleansing)\b(?!\s+prevention\b)/u;
const PRO_GENOCIDE = /\bpro[- ](?:genocide|ethnic cleansing)\b/u;
const PRESCRIPTIVE_GENOCIDE =
  /\b(?:(?:should|must|ought\s+to)\s+(?:commit|carry\s+out|promote|support)|(?:commit|carry\s+out)\s+(?:a\s+)?)\s*(?:genocide|ethnic cleansing)\b|\b(?:genocide|ethnic cleansing)\b.{0,30}\b(?:should|must)\s+(?:happen|be\s+(?:carried\s+out|supported|promoted))\b/u;

/**
 * Words that signal opposition, prevention, or condemnation of harm rather
 * than support for it. When one of these intervenes between an advocacy
 * word and a violence/class phrase, the statement is describing or fighting
 * the harm, not endorsing it.
 */
const ANTI_HARM =
  /\b(?:ban(?:s|ned|ning)?|banned|criminaliz(?:e|es|ed|ing)|outlaw(?:s|ed|ing)?|prohibit(?:s|ed|ing)?|prevent(?:s|ed|ing)?|prevention|preventive|protect(?:s|ed|ing)?|protection(?:s)?|protective|punish(?:es|ed|ing)?|prosecut(?:e|es|ed|ing)|condemn(?:s|ed|ing)?|denounc(?:e|es|ed|ing)|decry|criticiz(?:e|es|ed|ing)|oppos(?:e|es|ed|ing)|stop(?:s|ped|ping)?|end(?:s|ed|ing)?|fight(?:s|ing)?|combat(?:s|ing)?|curb(?:s|ed|ing)?|tackl(?:e|es|ed|ing)|suppress(?:es|ed|ing)?|address(?:es|ed|ing)?|reject(?:s|ed|ing)?|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|illegal|unlawful|wrong(?:ly)?|unjust(?:ified|ly)?|immoral|unacceptable|unnecessary|harmful|terrible|horrible|evil|bad|protest(?:s|ed|ing)?|action|survivor(?:s)?|victim(?:s)?|not|never)\b/u;

/**
 * Negations that precede an advocacy word and invert it ("do not support",
 * "no one should support", "should not be supported"). A negated advocacy
 * word does not endorse harm, so it must not trigger a block.
 */
const NEGATED_TRIGGER =
  /(?<!\b(?:not|never|don'?t|doesn'?t|didn'?t|can'?t|cannot|couldn'?t|wouldn'?t|shouldn'?t|mustn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|hardly|barely|scarcely|seldom|rarely)\s+|\b(?:no\s+one|nobody|no\s+person)\s+(?:should|must|would|will|can|could|may|might|do(?:es)?|did)\s+|\b(?:should|must|would|will|can|could|may|might|do(?:es)?|did|is|are|was|were|have|has|had)\s+(?:not|never)\s+(?:be\s+)?)/u;

/**
 * Builds a windowed advocacy pattern that blocks only when an advocacy or
 * approval word, a violence term, and a target (protected class or genocide
 * term) appear close together in the SAME sentence with no anti-harm word
 * in between. Global co-occurrence ("support" anywhere + "violence"
 * anywhere + "Jews" anywhere) is intentionally not enough: discussions of
 * hate-speech law legitimately mention violence against protected classes
 * while opposing it.
 */
function windowedHarmAdvocacy(
  triggerSrc: string,
  violenceSrc: string,
  targetSrc: string,
): RegExp {
  const trigger = `(?:${NEGATED_TRIGGER.source}${triggerSrc})\\b`;
  const violence = `(?:${violenceSrc})\\b`;
  const target = `(?:${targetSrc})\\b`;
  const gap = `(?:(?!\\b(?:${ANTI_HARM.source})\\b)[^.!?\\n])`;
  // After the phrase, an immediate "is/be ... illegal/wrong/prevented"
  // clause condemns the harm instead of endorsing it.
  const condemnedAfter =
    `(?!(?:[^.!?\\n]{0,24}(?:is|are|was|were|being|be|should|must|ought\\s+to|can|could|would|will|shall|may|might)` +
    `\\s+(?:not\\s+)?(?:be\\s+)?(?:banned|criminalized|illegal|prevented|prohibited|punished|unacceptable|unlawful|wrong|condemned|rejected|denounced|outlawed|prosecuted|unjustified|immoral|unnecessary|bad|harmful|terrible|horrible|evil|stopped|fought|combated|addressed|curbed|suppressed|ended)` +
    `|[^.!?\\n]{0,12}\\b(?:prevention|prohibition|ban|banned|banning)\\b))`;
  // trigger -> violence -> target, e.g. "advocate violence against Jews"
  const forward = `${trigger}${gap}{0,12}?${violence}${gap}{0,12}?${target}${condemnedAfter}`;
  // target -> trigger -> violence, e.g. "Jews deserve violence" (but not
  // "Jews deserve support against violence")
  const targetFirst = `${target}${gap}{0,12}?${trigger}(?!\\s*(?:support|help|care|justice|aid|assistance|protection|better|dignity|reparations|compensation|to\\s+live|to\\s+survive))${gap}{0,12}?${violence}`;
  // target -> violence -> trigger, e.g. "Jews are being attacked, and I support that"
  const backward = `${target}${gap}{0,12}?${violence}${gap}{0,12}?${trigger}`;
  // violence -> target -> trigger, e.g. "Violence against Jews is justified"
  const trailing = `${violence}${gap}{0,12}?${target}${gap}{0,12}?${trigger}`;
  return new RegExp(`${forward}|${targetFirst}|${backward}|${trailing}`, "iu");
}

/**
 * Windowed pattern for harm terms that ARE the target themselves (genocide,
 * ethnic cleansing): an advocacy/approval word adjacent to the term, with
 * anti-harm guards on both sides. A separate violence word is not required.
 */
function windowedDirectAdvocacy(triggerSrc: string, targetSrc: string): RegExp {
  const trigger = `(?:${NEGATED_TRIGGER.source}${triggerSrc})\\b`;
  const target = `(?<!\\b(?:prevention|protection|ban|banned|bans|banning|criminalization|prohibition|outlawing)\\s+of\\s+)` +
    `(?:${targetSrc})\\b`;
  const gap = `(?:(?!\\b(?:${ANTI_HARM.source})\\b)[^.!?\\n])`;
  const condemnedAfter =
    `(?!(?:[^.!?\\n]{0,24}(?:is|are|was|were|being|be|should|must|ought\\s+to|can|could|would|will|shall|may|might)` +
    `\\s+(?:not\\s+)?(?:be\\s+)?(?:banned|criminalized|illegal|prevented|prohibited|punished|unacceptable|unlawful|wrong|condemned|rejected|denounced|outlawed|prosecuted|unjustified|immoral|unnecessary|bad|harmful|terrible|horrible|evil|stopped|fought|combated|addressed|curbed|suppressed|ended)` +
    `|[^.!?\\n]{0,12}\\b(?:prevention|prohibition|ban|banned|banning)\\b))`;
  // trigger -> target, e.g. "Argue that genocide should be justified"
  const forward = `${trigger}${gap}{0,20}?${target}${condemnedAfter}`;
  // target -> trigger, e.g. "Genocide is desirable" / "Why genocide was good"
  const backward = `${target}${gap}{0,20}?${trigger}`;
  return new RegExp(`${forward}|${backward}`, "iu");
}

const HARM_TRIGGER_SRC = `${EXPLICIT_ADVOCACY.source}|${HARM_APPROVAL.source}`;
const WINDOWED_HARM_ADVOCACY = windowedHarmAdvocacy(
  HARM_TRIGGER_SRC,
  VIOLENCE.source,
  PROTECTED_CLASS.source,
);
const WINDOWED_GENOCIDE_ADVOCACY = windowedDirectAdvocacy(
  HARM_TRIGGER_SRC,
  GENOCIDE.source,
);

const EXTREMIST =
  /\b(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b/u;
const DIRECT_EXTREMIST_PRAISE =
  /\b(?:admir(?:e|es|ed|ing)|applaud(?:s|ed|ing)?|celebrat(?:e|es|ed|ing)|commend(?:s|ed|ing)?|defend(?:s|ed|ing)?|endors(?:e|es|ed|ing)|extol(?:s|led|ling)?|glorif(?:y|ies|ied|ying)|honou?r(?:s|ed|ing)?|prais(?:e|es|ed|ing)|promot(?:e|es|ed|ing)|rever(?:e|es|ed|ing)|support(?:s|ed|ing)?)\s+(?:(?:the\s+)?(?:actions?|achievements?|accomplishments?|ideology|legacy)\s+(?:by|of)\s+)?(?:the\s+)?(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b/u;
const DIRECT_EXTREMIST_DEFENSE =
  /\bdefen[cs]e\s+of\s+(?:the\s+)?(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b/u;
const EXTREMIST_APPROVAL =
  /\b(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b.{0,40}\b(?:admirable|deserve(?:s|d)?\s+(?:admiration|praise|respect|support)|did\s+nothing\s+wrong|good|great|hero(?:es|ic)?|honou?rable|praiseworthy|right|role model(?:s)?|should\s+be\s+(?:celebrated|defended|glorified|honoured|praised|supported))\b/u;
const EXTREMIST_PRAISE_CASE =
  /\b(?:argument|case)\s+(?:for|in\s+favou?r\s+of)\s+(?:(?:the\s+)?(?:(?:admiring|celebrating|defending|endorsing|glorifying|honouring|praising|promoting|supporting)\s+|(?:admiration|celebration|defen[cs]e|endorsement|glorification|honou?r|praise|promotion|support)\s+of\s+(?:the\s+)?))?(?:the\s+)?(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b|\bin\s+(?:favou?r|praise|support)\s+of\s+(?:the\s+)?(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b/u;

/** Deliberately small, reviewable rules for input and generated-output checks. */
export const DISCUSSION_POLICY_RULES: readonly ProhibitedCategoryRule[] = [
  {
    category: "genocide_advocacy",
    matches: (text) =>
      GENOCIDE.test(text) &&
      (WINDOWED_GENOCIDE_ADVOCACY.test(text) ||
        DIRECT_GENOCIDE_DEFENSE.test(text) ||
        PRESCRIPTIVE_GENOCIDE.test(text) ||
        PRO_GENOCIDE.test(text)),
  },
  {
    category: "protected_class_violence_advocacy",
    matches: (text) =>
      VIOLENCE.test(text) &&
      PROTECTED_CLASS.test(text) &&
      (WINDOWED_HARM_ADVOCACY.test(text) ||
        DIRECT_VIOLENCE_DEFENSE.test(text) ||
        PRESCRIPTIVE_VIOLENCE.test(text) ||
        DIRECT_VIOLENCE_ADVOCACY.test(text)),
  },
  {
    category: "extremist_praise",
    matches: (text) =>
      EXTREMIST.test(text) &&
      (DIRECT_EXTREMIST_PRAISE.test(text) ||
        DIRECT_EXTREMIST_DEFENSE.test(text) ||
        EXTREMIST_APPROVAL.test(text) ||
        EXTREMIST_PRAISE_CASE.test(text)),
  },
];

function evaluatePolicyText(text: string, now: () => Date): PolicyOutcome {
  const normalizedText = text.normalize("NFKC").toLowerCase();
  const blockedRule = DISCUSSION_POLICY_RULES.find((rule) =>
    rule.matches(normalizedText),
  );
  const checkedAt = now().toISOString();

  if (blockedRule) {
    return {
      decision: "blocked",
      category: blockedRule.category,
      checkedAt,
    };
  }

  return {
    decision: "allowed",
    category: null,
    checkedAt,
  };
}

/** Policy boundary for participant-authored Discussion Topics. */
export class DiscussionPolicy {
  constructor(private readonly now: () => Date = () => new Date()) {}

  evaluate(topic: DiscussionTopic): PolicyOutcome {
    return evaluatePolicyText(topic, this.now);
  }
}

export interface DiscussionOutputPolicyEvaluator {
  evaluate(content: string): PolicyOutcome;
}

/** Independent policy boundary for generated Turn content. */
export class DiscussionOutputPolicy implements DiscussionOutputPolicyEvaluator {
  constructor(private readonly now: () => Date = () => new Date()) {}

  evaluate(content: string): PolicyOutcome {
    return evaluatePolicyText(content, this.now);
  }
}
