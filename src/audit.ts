import { chromium } from 'playwright';
import OpenAI from 'openai';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Zod schema for structured output validation
const AuditResultSchema = z.object({
  overall: z.number().min(0).max(100),
  breakdown: z.object({
    accessibility: z.number().min(0).max(100),
    contentClarity: z.number().min(0).max(100),
    navigation: z.number().min(0).max(100),
    visualDesign: z.number().min(0).max(100),
    mobileFriendliness: z.number().min(0).max(100),
  }),
  improvements: z.array(z.object({
    title: z.string(),
    why: z.string(),
    how: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
  })),
  summary: z.object({
    executive: z.string(),
    developerTodo: z.array(z.string()),
  }),
});

type AuditResult = z.infer<typeof AuditResultSchema>;

// Environment validation
const requiredEnvVars = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY', 
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION'
];

function validateEnvironment(): void {
  const missing = requiredEnvVars.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function showUsage(): void {
  console.log('Usage: bun audit <URL>');
  console.log('       npm run audit <URL>');
  console.log('');
  console.log('Examples:');
  console.log('  bun audit https://example.com');
  console.log('  npm run audit https://github.com');
  process.exit(1);
}

async function takeScreenshots(url: string, outputDir: string): Promise<void> {
  const browser = await chromium.launch();
  
  // Desktop screenshot (1366x900)
  const desktopPage = await browser.newPage({
    viewport: { width: 1366, height: 900 }
  });
  
  await desktopPage.goto(url);
  await desktopPage.screenshot({ 
    path: join(outputDir, 'desktop.png'),
    fullPage: true
  });
  
  // Mobile screenshot (Pixel 7 dimensions)
  const mobilePage = await browser.newPage({
    viewport: { width: 412, height: 915 }
  });
  
  await mobilePage.goto(url);
  await mobilePage.screenshot({ 
    path: join(outputDir, 'mobile.png'),
    fullPage: true
  });
  
  await browser.close();
}

async function runAccessibilityAudit(url: string): Promise<any[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto(url);
  
  try {
    // Basic accessibility checks without axe-core for now
    const issues = await page.evaluate(() => {
      const violations = [];
      
      // Check for missing alt text
      const imagesWithoutAlt = document.querySelectorAll('img:not([alt])');
      if (imagesWithoutAlt.length > 0) {
        violations.push({
          id: 'image-alt',
          description: 'Images must have alternate text',
          nodes: Array.from(imagesWithoutAlt).map(img => ({ target: [img.tagName] }))
        });
      }
      
      // Check for missing form labels
      const inputsWithoutLabels = document.querySelectorAll('input:not([aria-label]):not([aria-labelledby])');
      if (inputsWithoutLabels.length > 0) {
        violations.push({
          id: 'label',
          description: 'Form elements must have labels',
          nodes: Array.from(inputsWithoutLabels).map(input => ({ target: [input.tagName] }))
        });
      }
      
      return violations;
    });
    
    await browser.close();
    return issues;
  } catch (error) {
    console.warn('Accessibility audit failed:', error);
    await browser.close();
    return [];
  }
}

async function evaluateWithOpenAI(url: string, a11yViolations: any[]): Promise<AuditResult> {
  const openai = new OpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    baseURL: `${process.env.AZURE_OPENAI_ENDPOINT!}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT!}`,
    defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION! },
    defaultHeaders: {
      'api-key': process.env.AZURE_OPENAI_API_KEY!,
    },
  });

  const violationsSummary = a11yViolations.length > 0 
    ? a11yViolations.map(v => `${v.id}: ${v.description} (${v.nodes.length} occurrences)`).join('\n')
    : 'No accessibility violations found';

  const prompt = `Analyze the UX of website: ${url}

Accessibility violations found:
${violationsSummary}

Please provide a comprehensive UX audit focusing on:
1. Overall user experience score (0-100)
2. Breakdown scores for accessibility, content clarity, navigation, visual design, and mobile-friendliness
3. Specific improvement recommendations with priority levels
4. Executive summary and developer action items

Consider the accessibility violations in your scoring and recommendations.`;

  const completion = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ux_audit_result',
        schema: {
          type: 'object',
          properties: {
            overall: { type: 'number', minimum: 0, maximum: 100 },
            breakdown: {
              type: 'object',
              properties: {
                accessibility: { type: 'number', minimum: 0, maximum: 100 },
                contentClarity: { type: 'number', minimum: 0, maximum: 100 },
                navigation: { type: 'number', minimum: 0, maximum: 100 },
                visualDesign: { type: 'number', minimum: 0, maximum: 100 },
                mobileFriendliness: { type: 'number', minimum: 0, maximum: 100 }
              },
              required: ['accessibility', 'contentClarity', 'navigation', 'visualDesign', 'mobileFriendliness']
            },
            improvements: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  why: { type: 'string' },
                  how: { type: 'string' },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] }
                },
                required: ['title', 'why', 'how', 'priority']
              }
            },
            summary: {
              type: 'object',
              properties: {
                executive: { type: 'string' },
                developerTodo: { 
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: ['executive', 'developerTodo']
            }
          },
          required: ['overall', 'breakdown', 'improvements', 'summary']
        }
      }
    }
  });

  const result = JSON.parse(completion.choices[0]?.message?.content || '{}');
  return AuditResultSchema.parse(result);
}

async function createOutputDirectory(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = join(process.cwd(), 'artifacts', timestamp);
  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
}

async function main(): Promise<void> {
  // Command line argument validation
  const url = process.argv[2];
  if (!url) {
    showUsage();
  }

  // Environment validation
  validateEnvironment();

  console.log(`🔍 Starting UX audit for: ${url}`);
  
  try {
    // Create output directory
    const outputDir = await createOutputDirectory();
    console.log(`📁 Output directory: ${outputDir}`);

    // Take screenshots
    console.log('📸 Taking screenshots...');
    await takeScreenshots(url, outputDir);

    // Run accessibility audit
    console.log('♿ Running accessibility audit...');
    const a11yViolations = await runAccessibilityAudit(url);
    console.log(`Found ${a11yViolations.length} accessibility violations`);

    // Evaluate with OpenAI
    console.log('🤖 Analyzing with AI...');
    const auditResult = await evaluateWithOpenAI(url, a11yViolations);

    // Save results
    const reportData = {
      url,
      timestamp: new Date().toISOString(),
      auditResult,
      a11yViolations,
    };

    await fs.writeFile(
      join(outputDir, 'report.json'),
      JSON.stringify(reportData, null, 2)
    );

    // Display summary
    console.log('\n✅ Audit complete!');
    console.log(`📊 Overall Score: ${auditResult.overall}/100`);
    console.log(`♿ Accessibility: ${auditResult.breakdown.accessibility}/100`);
    console.log(`📝 Content Clarity: ${auditResult.breakdown.contentClarity}/100`);
    console.log(`🧭 Navigation: ${auditResult.breakdown.navigation}/100`);
    console.log(`🎨 Visual Design: ${auditResult.breakdown.visualDesign}/100`);
    console.log(`📱 Mobile Friendliness: ${auditResult.breakdown.mobileFriendliness}/100`);
    
    console.log(`\n📄 Full report saved to: ${join(outputDir, 'report.json')}`);
    console.log(`🖼️  Screenshots saved to: ${outputDir}/`);

  } catch (error) {
    console.error('❌ Audit failed:', error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
