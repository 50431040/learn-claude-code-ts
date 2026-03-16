import * as readline from "readline";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { MessageParam } from "@anthropic-ai/sdk/resources";

dotenv.config({ path: "../.env" });

const anthropic = new Anthropic();

function runBash(bash: string) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((cmd) => bash.includes(cmd))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(bash, { encoding: "utf-8", cwd: process.cwd() });
    return output;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

async function agentLoop(messages: Array<MessageParam>) {
  while (true) {
    const response = await anthropic.messages.create({
      model: process.env.MODEL_ID,
      max_tokens: 10000,
      system: `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`,
      messages: messages,
      tools: [
        {
          name: "bash",
          description: "Run a shell command.",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });

    // 添加回复到消息列表
    messages.push({ role: "assistant", content: response.content });
    // 非工具调用，结束循环
    if (response.stop_reason !== "tool_use") {
      response.content.forEach((part) => {
        if (part.type === "text") {
          console.log(`Assistant: ${part.text}`);
        }
      });
      break;
    }

    const results = [];
    response.content.forEach((part) => {
      if (part.type === "tool_use") {
        const command = part.input["command"];
        console.log(`Running command: ${command}`);
        const output = runBash(part.input["command"]);
        results.push({
          type: "tool_result",
          tool_use_id: part.id,
          content: output,
        });
      }
    });
    messages.push({ role: "user", content: results });
  }
}

function ask() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question("s1> ", async (input) => {
    const initialMessages: Array<MessageParam> = [
      { role: "user", content: input },
    ];
    await agentLoop(initialMessages);
    rl.close();

    // 继续询问
    ask();
  });
}

ask();
