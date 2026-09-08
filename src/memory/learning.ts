import { isRecallQuestion } from './query.ts';

const EXPLICIT = /记住|偏好|更正|纠正|应该改成|改为|不对|以后|不要|\b(?:remember|prefer|correction|instead)\b/iu;
const IMPERATIVE = /(?:^|[.!?。！？]\s*)(?:please\s+)?remember\b|记住|更正|纠正|以后|不要/iu;

/** A bounded intent recognizer, not a general semantic classifier. A stated preference
 * or project requirement may precede a question asking for feedback. Mere questions,
 * examples and one-off execution requests are not new durable requirements. */
export function learningIntent(text: string): { learn: boolean; reason: string } {
 const clean = text.trim();
 if (!clean || /^(?:[>`"“「]|(?:例如|举例|假设|如果我说|example\b|suppose\b|if I say\b))/iu.test(clean)) return { learn: false, reason: 'quoted-or-example' };
 if (isRecallQuestion(clean) && !IMPERATIVE.test(clean)) return { learn: false, reason: 'recall-question' };
 const declaration = /(?:^|[。.!?\n]\s*)(?:(?:我|我们)(?:比较|最|更|主要|特别)?(?:在意|看重|喜欢|不喜欢|偏好|倾向于|决定采用|决定使用)|(?:我的|我们的|本项目的?|这个项目的?|项目的?)(?:核心)?(?:需求|要求|目标|优先级)\s*(?:是|为|[:：])|(?:I|we)\s+(?:care about|value|like|dislike|want to prioritize|decided to use|decided to adopt)\s+|(?:my|our)\s+(?:priorities|requirements|preferences|goals)\s+(?:are|include)\s+|(?:our|this)\s+(?:project|system)\s+(?:must|needs to|should)\s+)([^\n]+)/iu.exec(clean);
 if (declaration && declaration[1].trim().length >= 1 && !/^(?:什么|哪些|哪种|是否|怎么|如何|what\b|which\b|whether\b)/iu.test(declaration[1].trim())
  && !/^(?:这个|那个|这些|那些|它|this|that|it)[。.!?？]*$/iu.test(declaration[1].trim())) return { learn: true, reason: 'stated-requirement' };
 const durable = /(?:^|[。.!?\n]\s*)(?:我|我们)(?:希望|要求|需要|想要)([^。.!?\n]+)/u.exec(clean);
 if (durable && /项目|系统|长期|以后|默认|每次|总是|功能|需求|优先|自动/u.test(durable[1])
  && !/^(?:什么|哪些|是否|怎么|如何)/u.test(durable[1].trim())) return { learn: true, reason: 'stated-requirement' };
 if (!IMPERATIVE.test(clean) && /[?？]\s*$/u.test(clean)
  && /^(?:你|请问|如何|怎么|为什么|是否|什么|当前|我是否|我应该|what\b|how\b|why\b|should\b|can\b|do\b)/iu.test(clean)) return { learn: false, reason: 'question' };
 if (EXPLICIT.test(clean)) return { learn: true, reason: 'explicit-cue' };
 return { learn: false, reason: 'no-learning-intent' };
}
export function learningCue(text: string): boolean { return learningIntent(text).learn; }
