// Helper functions for formatting data for JIRA API

// Parse inline Markdown and Jira Wiki Markup (code, bold, links) into ADF text nodes
// Handles: `backtick`, {{wiki}}, **bold**, [label](url), bare http(s) URLs
function parseInlineMarkdown(text: string): any[] {
  const nodes: any[] = [];
  const regex = /(`[^`]+`|\{\{[^}]+\}\}|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]*[^\s<>.,;:!?)])/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }

    const matched = match[0];
    if (matched.startsWith("`")) {
      nodes.push({ type: "text", text: matched.slice(1, -1), marks: [{ type: "code" }] });
    } else if (matched.startsWith("{{")) {
      nodes.push({ type: "text", text: matched.slice(2, -2), marks: [{ type: "code" }] });
    } else if (matched.startsWith("**")) {
      nodes.push({ type: "text", text: matched.slice(2, -2), marks: [{ type: "strong" }] });
    } else if (matched.startsWith("[")) {
      const link = matched.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      nodes.push({ type: "text", text: link[1], marks: [{ type: "link", attrs: { href: link[2] } }] });
    } else {
      nodes.push({ type: "text", text: matched, marks: [{ type: "link", attrs: { href: matched } }] });
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

    // Headings: ## Title (Markdown) or h2. Title (Jira Wiki Markup)
    const mdHeadingMatch = line.match(/^(#{1,6})\s+(.+)/);
    const wikiHeadingMatch = line.match(/^h([1-6])\.\s+(.+)/);
    const headingMatch = mdHeadingMatch ?? wikiHeadingMatch;
    if (headingMatch) {
      const level = mdHeadingMatch ? headingMatch[1].length : parseInt(headingMatch[1], 10);
      adfContent.push({
        type: "heading",
        attrs: { level },
        content: parseInlineMarkdown(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Fenced code block: ```lang ... ```
    const fenceMatch = line.match(/^```\s*(\S*)\s*$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const codeBlock: any = { type: "codeBlock" };
      if (fenceMatch[1]) codeBlock.attrs = { language: fenceMatch[1] };
      if (codeLines.length > 0) codeBlock.content = [{ type: "text", text: codeLines.join("\n") }];
      adfContent.push(codeBlock);
      continue;
    }

    // Group consecutive bullet points into a single list.
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

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: { level?: number; language?: string; href?: string; url?: string; text?: string; order?: number };
  marks?: { type: string; attrs?: { href?: string } }[];
};

function codeFence(text: string, min: number) {
  const length = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length + 1), min);
  return "`".repeat(length);
}

export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as AdfNode | null;
  if (!node || typeof node !== "object") return "";
  const parts = Array.isArray(node.content) ? node.content.map(adfToMarkdown) : [];
  const text = parts.join("");
  switch (node.type) {
    case "doc":
    case "panel":
    case "listItem": return parts.join("\n\n");
    case "paragraph": return text;
    case "heading": return `${"#".repeat(Math.max(1, Math.min(6, node.attrs?.level || 1)))} ${text}`;
    case "hardBreak": return "  \n";
    case "rule": return "---";
    case "mention": return node.attrs?.text ?? "";
    case "inlineCard": return node.attrs?.url ?? "";
    case "blockquote": return parts.join("\n\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "codeBlock": {
      const fence = codeFence(text, 3);
      return `${fence}${node.attrs?.language ?? ""}\n${text}\n${fence}`;
    }
    case "bulletList":
    case "orderedList": return parts.map((part, index) => {
      const prefix = node.type === "bulletList" ? "- " : `${(node.attrs?.order ?? 1) + index}. `;
      return prefix + part.replaceAll("\n", `\n${" ".repeat(prefix.length)}`);
    }).join("\n");
    case "text": return (node.marks ?? []).reduce((content, mark) => {
      if (mark.type === "strong") return `**${content}**`;
      if (mark.type === "em") return `*${content}*`;
      if (mark.type === "strike") return `~~${content}~~`;
      if (mark.type === "code") {
        const fence = codeFence(content, 1);
        return `${fence}${content}${fence}`;
      }
      if (mark.type === "link" && mark.attrs?.href) return `[${content}](${mark.attrs.href})`;
      return content;
    }, node.text ?? "");
    default: return parts.join("\n");
  }
}
