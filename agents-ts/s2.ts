import * as readline from "readline";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources";
import path = require("path");
import fs = require("fs");

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

function readFile(path: string, limit?: number) {
  try {
    const content = fs.readFileSync(path, "utf-8");
    return limit ? content.slice(0, limit) : content;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

function writeFile(path: string, content: string) {
  try {
    fs.writeFileSync(path, content, "utf-8");
    return "File written successfully";
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

function editFile(path: string, oldText: string, newText: string) {
  try {
    let content = fs.readFileSync(path, "utf-8");
    if (!content.includes(oldText)) {
      return "Error: old_text not found in file";
    }
    content = content.replace(oldText, newText);
    fs.writeFileSync(path, content, "utf-8");
    return "File edited successfully";
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

const tools: Array<ToolUnion> = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "read file content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read." },
        limit: {
          type: "number",
          description: "Maximum number of bytes to read.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "write file content.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description: "edit file content.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
];

// 模型返回的参数为对象，需要对参数进行解析
const toolHandlers = {
    bash: ({ command }: { command: string }) => runBash(command),
    read_file: ({ path, limit }: { path: string; limit?: number }) => readFile(path, limit),
    write_file: ({ path, content }: { path: string; content: string }) => writeFile(path, content),
    edit_file: ({ path, old_text, new_text }: { path: string; old_text: string; new_text: string }) => editFile(path, old_text, new_text),
};

async function agentLoop(messages: Array<MessageParam>) {
  while (true) {
    const response = await anthropic.messages.create({
      model: process.env.MODEL_ID,
      max_tokens: 10000,
      system: `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`,
      messages: messages,
      tools,
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
        // 对应的工具处理函数
        const handler = toolHandlers[part.name];
        if (!handler) {
          results.push({
            type: "tool_result",
            tool_use_id: part.id,
            content: `Error: No handler for tool ${part.name}`,
          });
          return;
        }
        console.log(`Running tool: ${part.name} with input ${JSON.stringify(part.input)}`);
        const output = handler(part.input);
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

// 全局上下文
const messages = []
function ask() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question("s1> ", async (input) => {
    messages.push({ role: "user", content: input });
    await agentLoop(messages);
    rl.close();

    // 继续询问
    ask();
  });
}

ask();
