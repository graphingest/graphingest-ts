/**
 * Problem: LLM Rate Limits Kill Your Content Pipeline
 *
 * 500 OpenAI calls in a loop → rate limit at #100 → crash → restart → $200 wasted.
 *
 * Solution: ThrottlePolicy caps at 50/min, cacheTtl prevents duplicate calls,
 * retries handle 429s automatically.
 *
 * Run: npx tsx llm_content.ts
 */

import { node, graph, deploy } from "graphingest";

const generateBlogPost = node(
  { name: "generate-blog-post", cacheTtl: 86400, maxRetries: 5 },
  async (topic: { title: string }) => {
    // In production: call OpenAI
    return { topic: topic.title, content: `Blog about ${topic.title}...`, wordCount: 800 };
  }
);

const generateSocialPosts = node(
  { name: "generate-social-posts", cacheTtl: 86400, maxRetries: 5 },
  async (blog: { topic: string; content: string }) => ({
    topic: blog.topic,
    twitter: `🧵 ${blog.topic} — a thread...`,
    linkedin: `I just published: ${blog.topic}...`,
  })
);

const contentPipeline = graph({
  name: "content-pipeline",
  // throttle: { limit: 50, periodSeconds: 60 },  // 50 LLM calls/min
  // concurrency: { limit: 10, key: "userId" },    // 10 parallel per user
  retryPolicy: { maxRetries: 3, delayMs: 2000, backoffFactor: 3 },
  timeoutMs: 1_800_000,
}, async (topics: Array<{ title: string }>) => {
  const blogs = await (generateBlogPost as any).map(topics);
  const social = await (generateSocialPosts as any).map(blogs);
  return { topicsProcessed: topics.length, blogs: blogs.length, socialPosts: social.length };
});

await deploy();

const result = await contentPipeline([
  { title: "AI in Healthcare" },
  { title: "Remote Work Best Practices" },
  { title: "Sustainable Energy Trends" },
]);
console.log(`Generated ${result.blogs} blogs and ${result.socialPosts} social post sets`);
