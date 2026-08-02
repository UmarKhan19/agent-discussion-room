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
      (EXPLICIT_ADVOCACY.test(text) ||
        DIRECT_GENOCIDE_DEFENSE.test(text) ||
        HARM_APPROVAL.test(text) ||
        PRESCRIPTIVE_GENOCIDE.test(text) ||
        PRO_GENOCIDE.test(text)),
  },
  {
    category: "protected_class_violence_advocacy",
    matches: (text) =>
      VIOLENCE.test(text) &&
      PROTECTED_CLASS.test(text) &&
      (EXPLICIT_ADVOCACY.test(text) ||
        DIRECT_VIOLENCE_DEFENSE.test(text) ||
        HARM_APPROVAL.test(text) ||
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
