export const tool = {
  name: "echo_text",
  description: "Echo input text back to the caller.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to echo" }
    },
    required: ["text"]
  }
};

export async function handler(args) {
  return {
    content: [
      {
        type: "text",
        text: String(args?.text ?? "")
      }
    ]
  };
}

