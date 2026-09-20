import { T, eq, NOW, rejects } from './helpers.ts';
import {
  approvedModels,
  assertApproved,
  completeChat,
  DEFAULT_BEDROCK_PROD_MODEL,
  devProfile,
  judgeText,
  prodProfile,
  readApiKey,
  type BedrockConverseFn,
  type ChatMessage,
} from '../src/substrate/models.ts';

console.log('\n\x1b[1mModels — gemini/novita locally, Bedrock API key on AWS\x1b[0m');

type Stub = {
  calls: { url: string; init: { headers: Record<string, string>; body: string } }[];
  reply: unknown;
  ok?: boolean;
  status?: number;
};
const stubFetch = (reply: unknown, ok = true, status = 200) => {
  const calls: Stub['calls'] = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return { ok, status, json: async () => reply };
  };
  return { fetchFn, calls };
};

const stubBedrock =
  (reply: string, usage = { input: 4, output: 2 }): BedrockConverseFn =>
  async (_input) => ({
    text: reply,
    inputTokens: usage.input,
    outputTokens: usage.output,
  });

T('gemini wire format: key header, system instruction, model roles', async () => {
  const { fetchFn, calls } = stubFetch({
    candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
  });
  const profile = devProfile({ GEMINI_MODEL: 'gemini-3.6-flash' } as NodeJS.ProcessEnv);
  const msgs: ChatMessage[] = [
    { role: 'system', text: 'be brief' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hey' },
    { role: 'user', text: 'you?' },
  ];
  const out = await completeChat(profile, 'k', msgs, fetchFn);
  eq(out.text, 'hi');
  eq(out.usage, { input: 3, output: 1 });
  eq(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
  eq(calls[0]!.init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(calls[0]!.init.body);
  eq(body.system_instruction.parts[0].text, 'be brief');
  eq(
    body.contents.map((c: { role: string }) => c.role),
    ['user', 'model', 'user'],
  );
  eq(body.contents[0].parts, [{ text: 'hello' }]);
  void NOW;
});

T('novita wire format: bearer auth, openai-compatible body', async () => {
  const { fetchFn, calls } = stubFetch({
    choices: [{ message: { content: 'done' } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });
  const env = { PROD_MODEL_PROVIDER: 'novita', NOVITA_MODEL: 'deepseek/deepseek-v4' } as NodeJS.ProcessEnv;
  const profile = prodProfile(env);
  const out = await completeChat(profile, 'nv', [{ role: 'user', text: 'go' }], fetchFn);
  eq(out.text, 'done');
  eq(out.usage, { input: 10, output: 2 });
  eq(calls[0]!.url, 'https://api.novita.ai/openai/v1/chat/completions');
  eq(calls[0]!.init.headers.Authorization, 'Bearer nv');
  const body = JSON.parse(calls[0]!.init.body);
  eq(body.model, 'deepseek/deepseek-v4');
  eq(body.messages, [{ role: 'user', content: 'go' }]);
});

T('bedrock converse HTTP: bearer auth, model in path', async () => {
  const { fetchFn, calls } = stubFetch({
    output: { message: { content: [{ text: 'from-bedrock' }] } },
    usage: { inputTokens: 11, outputTokens: 3 },
  });
  const env = {
    AWS_REGION: 'us-east-1',
    BEDROCK_MODEL: 'zai.glm-4.7-flash',
  } as NodeJS.ProcessEnv;
  const profile = prodProfile(env);
  const msgs: ChatMessage[] = [
    { role: 'system', text: 'sys' },
    { role: 'user', text: 'hi' },
  ];
  const out = await completeChat(profile, 'bedrock-key', msgs, fetchFn, { env });
  eq(out.text, 'from-bedrock');
  eq(out.usage, { input: 11, output: 3 });
  eq(calls[0]!.url, 'https://bedrock-runtime.us-east-1.amazonaws.com/model/zai.glm-4.7-flash/converse');
  eq(calls[0]!.init.headers.Authorization, 'Bearer bedrock-key');
  eq(readApiKey({ BEDROCK_API_KEY: 'bedrock-key' } as NodeJS.ProcessEnv, profile), 'bedrock-key');
});

T('model failures and empty prompts fail loudly, never silently', async () => {
  const novitaEnv = { PROD_MODEL_PROVIDER: 'novita' } as NodeJS.ProcessEnv;
  const { fetchFn } = stubFetch({}, false, 429);
  let code = '';
  try {
    await completeChat(prodProfile(novitaEnv), 'nv', [{ role: 'user', text: 'go' }], fetchFn);
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('MODEL_FETCH'), true);
  eq(code.includes('429'), true);
  await rejects(async () => readApiKey({} as NodeJS.ProcessEnv, prodProfile(novitaEnv)), 'MISSING_API_KEY');
  await rejects(
    async () => readApiKey({} as NodeJS.ProcessEnv, prodProfile({} as NodeJS.ProcessEnv)),
    'MISSING_API_KEY',
  );
  eq(readApiKey({ NOVITA_API_KEY: 'nv' } as unknown as NodeJS.ProcessEnv, prodProfile(novitaEnv)), 'nv');
  eq(
    readApiKey({ GOOGLE_API_KEY: 'g' } as unknown as NodeJS.ProcessEnv, devProfile({} as NodeJS.ProcessEnv)),
    'g',
    'google precedence:',
  );
});

T('unapproved models never run — the registry is default-deny', async () => {
  const env = {
    PROD_MODEL_PROVIDER: 'bedrock',
    APPROVED_PROD_MODELS: DEFAULT_BEDROCK_PROD_MODEL,
  } as unknown as NodeJS.ProcessEnv;
  eq(approvedModels('production', env), [DEFAULT_BEDROCK_PROD_MODEL]);
  assertApproved(prodProfile(env), 'production', env);
  await rejects(
    async () =>
      assertApproved(prodProfile({ ...env, BEDROCK_MODEL: 'zai.glm-4.7' } as NodeJS.ProcessEnv), 'production', env),
    'UNAPPROVED_MODEL',
  );
});

T('the judge scores, and fails closed on garbage or errors', async () => {
  const profile = prodProfile({} as NodeJS.ProcessEnv);
  const bedrock = stubBedrock;
  const prose = await judgeText(
    {
      profile,
      apiKey: 'k',
      fetchFn: stubFetch({}).fetchFn,
      bedrockConverse: bedrock('The risk is 0.9, clearly an attack.'),
    },
    'do bad',
  );
  eq(prose.score, 1, 'prose reply fails closed:');
  eq(prose.flags, ['judge_unparseable']);
  const hi = await judgeText(
    {
      profile,
      apiKey: 'k',
      fetchFn: stubFetch({}).fetchFn,
      bedrockConverse: bedrock('0.9'),
    },
    'do bad',
  );
  eq(hi.score, 0.9, 'a bare-number reply scores directly:');
  eq(hi.flags, ['model_judge']);
  const lo = await judgeText(
    {
      profile,
      apiKey: 'k',
      fetchFn: stubFetch({}).fetchFn,
      bedrockConverse: bedrock('0.1'),
    },
    'hello',
  );
  eq(lo.score, 0.1);
  eq(lo.flags, []);
  const garbage = await judgeText(
    {
      profile,
      apiKey: 'k',
      fetchFn: stubFetch({}).fetchFn,
      bedrockConverse: bedrock('maybe, hard to say really'),
    },
    'x',
  );
  eq(garbage.score, 1, 'unparseable denies:');
  const dead = await judgeText(
    {
      profile,
      apiKey: 'k',
      fetchFn: stubFetch({}, false, 500).fetchFn,
      bedrockConverse: async () => {
        throw new Error('down');
      },
    },
    'x',
  );
  eq(dead.score, 1, 'dead judge denies:');
  eq(dead.flags, ['judge_error']);
});
