import type {
  DiscussionTopic,
  PolicyCategory,
  PolicyOutcome,
} from "./contracts";

export const SAFE_TOPIC_ALTERNATIVE =
  "Choose a Topic that critically examines prevention, history, consequences, or human rights without praising extremists or advocating harm.";

interface ProhibitedCategoryRule {
  category: PolicyCategory;
  matches(topic: string): boolean;
}

const ADVOCACY =
  /\b(?:advocat(?:e|es|ing)|argu(?:e|es|ing)\s+(?:for|that)|call(?:s|ing)?\s+for|case\s+for|in\s+favou?r\s+of|celebrat(?:e|es|ing)|defend(?:s|ing)?|endors(?:e|es|ing)|glorif(?:y|ies|ying)|justif(?:y|ies|ied|ying)|prais(?:e|es|ing)|promot(?:e|es|ing)|support(?:s|ing)?|should|must|deserve(?:s|d)?)\b/u;
const VIOLENCE =
  /\b(?:attack(?:s|ed|ing)?|exterminat(?:e|es|ed|ing|ion)|harm(?:s|ed|ing)?|kill(?:s|ed|ing)?|murder(?:s|ed|ing)?|shoot(?:s|ing)?|violence|violent)\b/u;
const PROTECTED_CLASS =
  /\b(?:protected[- ]class(?:es)?|racial|race|ethnic(?:ity)?|religious|religion|nationality|women|woman|men|man|gay|lesbian|bisexual|transgender|disabled|disability|black people|white people|jews?|jewish|muslims?|christians?|hindus?|sikhs?)\b/u;
const GENOCIDE = /\b(?:genocide|ethnic cleansing)\b/u;
const DIRECT_VIOLENCE_ADVOCACY =
  /(?:^|[.!?]\s*)(?:attack|exterminate|harm|kill|murder|shoot)\b/u;
const EXTREMIST =
  /\b(?:extremist(?:s| groups?| organizations?)?|terrorist(?:s| groups?| organizations?)?|isis|isil|daesh|al[- ]qaeda|neo[- ]nazi(?:s)?|ku klux klan|kkk)\b/u;
const EXTREMIST_PRAISE =
  /\b(?:case\s+for|in\s+favou?r\s+of|admir(?:e|es|ed|ing|able)|celebrat(?:e|es|ed|ing)|defend(?:s|ed|ing)?|endors(?:e|es|ed|ing)|glorif(?:y|ies|ied|ying)|hero(?:es|ic)?|honou?r(?:s|ed|ing|able)?|prais(?:e|es|ed|ing)|promot(?:e|es|ed|ing)|role model(?:s)?|support(?:s|ed|ing)?)\b/u;
const SAFE_CRITICAL_FRAMING =
  /\b(?:address(?:es|ed|ing)?|challenge(?:s|d|ing)?|condemn(?:s|ed|ing|ation)?|counter(?:s|ed|ing)?|critic(?:al|ise|ize|ises|izes|ised|ized|ising|izing)|document(?:s|ed|ing)?|educat(?:e|es|ed|ing|ion)|investigat(?:e|es|ed|ing|ion)|oppos(?:e|es|ed|ing|ition)|prevent(?:s|ed|ing|ion)?|reduc(?:e|es|ed|ing|tion)|respond(?:s|ed|ing)?|stop(?:s|ped|ping)?|understand(?:s|ing)?)\b/u;

/** Deliberately small, reviewable policy configuration for pre-generation checks. */
export const PROHIBITED_TOPIC_RULES: readonly ProhibitedCategoryRule[] = [
  {
    category: "genocide_advocacy",
    matches: (topic) =>
      GENOCIDE.test(topic) &&
      ADVOCACY.test(topic) &&
      !SAFE_CRITICAL_FRAMING.test(topic),
  },
  {
    category: "protected_class_violence_advocacy",
    matches: (topic) =>
      (ADVOCACY.test(topic) || DIRECT_VIOLENCE_ADVOCACY.test(topic)) &&
      VIOLENCE.test(topic) &&
      PROTECTED_CLASS.test(topic) &&
      !SAFE_CRITICAL_FRAMING.test(topic),
  },
  {
    category: "extremist_praise",
    matches: (topic) =>
      EXTREMIST.test(topic) &&
      EXTREMIST_PRAISE.test(topic) &&
      !SAFE_CRITICAL_FRAMING.test(topic),
  },
];

export class DiscussionPolicy {
  constructor(private readonly now: () => Date = () => new Date()) {}

  evaluate(topic: DiscussionTopic): PolicyOutcome {
    const normalizedTopic = topic.normalize("NFKC").toLowerCase();
    const blockedRule = PROHIBITED_TOPIC_RULES.find((rule) =>
      rule.matches(normalizedTopic),
    );
    const checkedAt = this.now().toISOString();

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
}
