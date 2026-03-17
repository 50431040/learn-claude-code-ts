import * as readline from "readline";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources";
import path = require("path");
import fs = require("fs");

dotenv.config({ path: "../.env" });

const anthropic = new Anthropic();
// prompt调整
const systemPrompt = `You are a coding agent at ${process.cwd()}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;
const subAgentPrompt = `You are a coding subagent at ${process.cwd()}. Complete the given task, then summarize your findings.`;

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

async function runSubAgent(prompt: string) {
  const messages: MessageParam[] = [{ role: "user", content: prompt }];
  let response: Anthropic.Messages.Message & {
    _request_id?: string | null;
  };
  while (true) {
    response = await anthropic.messages.create({
      model: process.env.MODEL_ID,
      max_tokens: 10000,
      system: subAgentPrompt,
      messages: messages,
      tools: childTools,
    });

    // 添加回复到消息列表
    messages.push({ role: "assistant", content: response.content });
    // 非工具调用，结束循环
    if (response.stop_reason !== "tool_use") {
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
        console.log(
          `SubAgent Running tool: ${part.name} with input ${JSON.stringify(part.input)}`,
        );
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

  return (
    response.content.find((item) => item.type === "text")?.text ||
    "(no summary)"
  );
}

class TodoManager {
  items: Array<any> = [];

  update(items: Array<any>) {
    let inProgressCount = 0;
    const validated = [];
    for (const item of items) {
      const { id, text, status } = item;
      if (
        !id ||
        !text ||
        !status ||
        !["pending", "in_progress", "completed"].includes(status)
      ) {
        return `Invalid item: ${JSON.stringify(item)}`;
      }

      if (status === "in_progress") {
        inProgressCount++;
      }
      validated.push({ id, text, status });
    }

    if (inProgressCount > 1) {
      return `Error: Only one task can be in_progress at a time. Found ${inProgressCount}.`;
    }

    this.items = validated;
    return this.render();
  }

  render() {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines = [];
    let completedCount = 0;
    this.items.forEach((item) => {
      const markerObj = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      };
      const marker = markerObj[item.status];
      lines.push(`${marker} ${item.id}: ${item.text}`);
    });

    lines.push(`Progress: ${completedCount}/${this.items.length} completed.`);
    return lines.join("\n");
  }
}

const todo = new TodoManager();

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
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description:
      "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  },
];

// subAgent工具，过滤掉task，子agent不需要调用自己
const childTools = tools.filter((tool) => tool.name !== "task");

// 模型返回的参数为对象，需要对参数进行解析
const toolHandlers = {
  bash: ({ command }: { command: string }) => runBash(command),
  read_file: ({ path, limit }: { path: string; limit?: number }) =>
    readFile(path, limit),
  write_file: ({ path, content }: { path: string; content: string }) =>
    writeFile(path, content),
  edit_file: ({
    path,
    old_text,
    new_text,
  }: {
    path: string;
    old_text: string;
    new_text: string;
  }) => editFile(path, old_text, new_text),
  todo: ({ items }: { items: Array<any> }) => todo.update(items),
  task: ({ prompt }: { prompt: string }) => runSubAgent(prompt),
};

async function agentLoop(messages: Array<MessageParam>) {
  while (true) {
    const response = await anthropic.messages.create({
      model: process.env.MODEL_ID,
      max_tokens: 10000,
      system: systemPrompt,
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
    // 调整为for...of循环，方便使用await
    for (const part of response.content) {
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
        console.log(
          `Running tool: ${part.name} with input ${JSON.stringify(part.input)}`,
        );
        const output = await handler(part.input);
        results.push({
          type: "tool_result",
          tool_use_id: part.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// 全局上下文
const messages = [];
function ask() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question("s4> ", async (input) => {
    messages.push({ role: "user", content: input });
    await agentLoop(messages);
    rl.close();

    // 继续询问
    ask();
  });
}

ask();
