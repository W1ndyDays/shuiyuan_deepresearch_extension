import assert from "node:assert/strict";
import { chatJson, LlmError } from "../lib/llm.mjs";

const cfg = {
  style: "openai",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  model: "reasoning-model",
};

function response(content, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

{
  const requests = [];
  const responses = [
    response("", "length"),
    response('{"agents":["campus"]}'),
  ];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return responses.shift();
  };

  const result = await chatJson(cfg, {
    system: "规划检索。",
    user: "查找水源社区里的校园生活信息。",
    maxTokens: 512,
  });

  assert.deepEqual(result, { agents: ["campus"] });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].messages.at(-1).content,
    "查找水源社区里的校园生活信息。",
  );
  assert.ok(requests[1].max_tokens >= 4096);
}

{
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response("", "length");
  };

  await assert.rejects(
    chatJson(cfg, {
      system: "规划检索。",
      user: "查找水源社区里的课程信息。",
      maxTokens: 512,
    }),
    (error) =>
      error instanceof LlmError &&
      error.message.includes("LLM 返回了空内容"),
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) =>
    request.messages.every((message) => String(message.content || "").trim()),
  ));
}

console.log("llm-empty-json regression tests passed");
