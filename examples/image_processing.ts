/**
 * Problem: Processing 10,000 Images Takes Hours
 *
 * E-commerce bulk upload: resize, watermark, optimize 10K images.
 * Sequential = 8 hours. Lambda timeout = 15 min. Step Functions = 256KB state limit.
 *
 * Solution: .map() fans out all 10,000 in parallel. Each image gets retries.
 * Whole batch finishes in minutes.
 *
 * Run: npx tsx image_processing.ts
 */

import { node, graph, deploy } from "graphingest";

const resizeImage = node(
  { name: "resize-image", maxRetries: 3 },
  async (image: { id: string; url: string }) => ({
    id: image.id,
    sizes: {
      thumb: `https://cdn.example.com/${image.id}_thumb.webp`,
      medium: `https://cdn.example.com/${image.id}_medium.webp`,
      large: `https://cdn.example.com/${image.id}_large.webp`,
    },
  })
);

const addWatermark = node({ name: "add-watermark" },
  async (image: any) => ({ ...image, watermarked: true })
);

const optimizeForWeb = node({ name: "optimize-for-web" },
  async (image: any) => ({ ...image, optimized: true, savingsPercent: 42 })
);

const imagePipeline = graph({
  name: "image-pipeline",
  retryPolicy: { maxRetries: 2, delayMs: 1000 },
  timeoutMs: 3_600_000, // 1 hour
}, async (images: Array<{ id: string; url: string }>) => {
  // Fan-out: all images in parallel at each stage
  const resized = await (resizeImage as any).map(images);
  const watermarked = await (addWatermark as any).map(resized);
  const optimized = await (optimizeForWeb as any).map(watermarked);
  return { totalProcessed: optimized.length, sample: optimized.slice(0, 3) };
});

await deploy();

const images = Array.from({ length: 100 }, (_, i) => ({
  id: `product-${i}`,
  url: `https://uploads.example.com/raw/${i}.jpg`,
}));

const result = await imagePipeline(images);
console.log(`Processed ${result.totalProcessed} images`);
