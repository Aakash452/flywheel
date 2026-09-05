/**
 * Renders an issue's stored Markdown (issues.body_md) to HTML for sending.
 *
 * Beehiiv's create-post endpoint accepts either structured `blocks` or raw
 * `body_content` HTML (and strips <style>/<link> tags on the way in — see
 * src/integrations/beehiiv/client.ts). We author and store issues as
 * Markdown — easier for both Claude and a human editor to work with in the
 * approval queue — and render to HTML only at send time.
 */
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

export function renderIssueHtml(bodyMd: string): string {
  const html = marked.parse(bodyMd, { async: false });
  if (typeof html !== "string") {
    throw new Error("marked.parse returned a Promise; expected sync output");
  }
  return html;
}
