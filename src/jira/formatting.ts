// Helper functions for formatting data for JIRA API

// Parse inline Markdown (code, bold) into ADF text nodes
function parseInlineMarkdown(text: string): any[] {
  const nodes: any[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }

    const matched = match[0];
    if (matched.startsWith("`")) {
      nodes.push({ type: "text", text: matched.slice(1, -1), marks: [{ type: "code" }] });
    } else {
      nodes.push({ type: "text", text: matched.slice(2, -2), marks: [{ type: "strong" }] });
    }

    lastIndex = match.index + matched.length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", text }];
}

// Helper function to format text content for JIRA API v3 (Markdown → ADF)
export function formatJiraContent(
  content: string | undefined,
  defaultText: string = "No content provided"
) {
  if (!content) {
    return {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: defaultText }] }],
    };
  }

  const lines = content.split("\n");
  const adfContent: any[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings: ## Title → heading level 2
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      adfContent.push({
        type: "heading",
        attrs: { level: headingMatch[1].length },
        content: parseInlineMarkdown(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Bullet list items — group consecutive ones into a single bulletList node
    if (/^[-*]\s+/.test(line)) {
      const listItems: any[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*]\s+/, "");
        listItems.push({
          type: "listItem",
          content: [{ type: "paragraph", content: parseInlineMarkdown(itemText) }],
        });
        i++;
      }
      adfContent.push({ type: "bulletList", content: listItems });
      continue;
    }

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph
    adfContent.push({ type: "paragraph", content: parseInlineMarkdown(line) });
    i++;
  }

  return {
    type: "doc",
    version: 1,
    content: adfContent.length > 0 ? adfContent : [{ type: "paragraph", content: [{ type: "text", text: content }] }],
  };
}

// Helper function to format description for JIRA API v3
export function formatDescription(description: string | undefined) {
  return formatJiraContent(description, "No description provided");
}

// Helper function to format acceptance criteria for JIRA API v3
export function formatAcceptanceCriteria(criteria: string | undefined) {
  // Check if criteria is undefined or empty
  if (!criteria) {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "No acceptance criteria provided",
            },
          ],
        },
      ],
    };
  }

  // Split criteria by newlines to handle bullet points properly
  const lines = criteria.split("\n");
  const content = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines
    if (!trimmedLine) continue;

    // Check if line is a bullet point
    if (trimmedLine.startsWith("-") || trimmedLine.startsWith("*")) {
      content.push({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: trimmedLine.substring(1).trim(),
                  },
                ],
              },
            ],
          },
        ],
      });
    } else {
      // Regular paragraph
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: trimmedLine,
          },
        ],
      });
    }
  }

  return {
    type: "doc",
    version: 1,
    content: content,
  };
}

/**
 * Extracts plain text from Atlassian Document Format (ADF).
 * Recursively traverses the ADF structure to extract all text content.
 *
 * @param adf - The ADF document or node to extract text from
 * @returns Plain text representation of the ADF content
 */
export function extractTextFromAdf(adf: any): string {
  if (!adf) {
    return "";
  }

  // If it's a string, return it directly
  if (typeof adf === "string") {
    return adf;
  }

  // If it's a text node, return the text
  if (adf.type === "text" && adf.text) {
    return adf.text;
  }

  // If it has content array, recursively extract text from each node
  if (Array.isArray(adf.content)) {
    const parts: string[] = [];

    for (const node of adf.content) {
      const text = extractTextFromAdf(node);
      if (text) {
        parts.push(text);
      }
    }

    // Add appropriate separators based on node types
    if (adf.type === "paragraph" || adf.type === "heading") {
      return parts.join("") + "\n";
    }

    if (adf.type === "bulletList" || adf.type === "orderedList") {
      return parts.join("");
    }

    if (adf.type === "listItem") {
      return "• " + parts.join("") + "\n";
    }

    if (adf.type === "codeBlock") {
      return "```\n" + parts.join("") + "\n```\n";
    }

    return parts.join("");
  }

  return "";
}
