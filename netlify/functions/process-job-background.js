// Process job background function - calls Claude and saves result
// Named with -background suffix to enable 15 minute timeout
const https = require('https');
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    // Connect Lambda to enable automatic Blobs configuration
    connectLambda(event);
    
    // Background functions don't return responses to clients
    // They just process and save results

    let jobId;
    let store;

    try {
        const { jobId: id } = JSON.parse(event.body);
        jobId = id;
        
        console.log('Processing job:', jobId);
        
        // Get the store
        store = getStore('essay-jobs');
        
        // Get the job data
        const job = await store.get(jobId, { type: 'json' });
        if (!job) {
            console.error('Job not found:', jobId);
            return; // Background functions don't return to client
        }

        const body = job.input;
        console.log('Subject:', body.subject);

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            await store.setJSON(jobId, { status: 'error', error: 'ANTHROPIC_API_KEY not configured' });
            return;
        }

        console.log('Calling Claude Sonnet...');
        const messages = buildMessages(body);
        const claudeData = await makeRequest(apiKey, messages);
        console.log('Claude response received');

        if (claudeData.error) {
            console.error('Claude error:', JSON.stringify(claudeData.error));
            await store.setJSON(jobId, { status: 'error', error: claudeData.error });
            return;
        }

        let config = extractJavaScript(claudeData.content[0].text);
        console.log('Config generated, length:', config.length);

        // Post-process: inject actual source material and images
        config = injectSourceContent(config, body);
        console.log('Source content injected, final length:', config.length);

        // Save the result
        await store.setJSON(jobId, {
            status: 'completed',
            config: config,
            timestamp: Date.now()
        });

        console.log('Result saved successfully');

    } catch (error) {
        console.error('Error:', error);
        if (store && jobId) {
            try {
                await store.setJSON(jobId, { status: 'error', error: error.message });
            } catch (e) {
                console.error('Failed to save error state:', e);
            }
        }
    }
};

function makeRequest(apiKey, messages) {
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8000,
            messages: messages
        });

        const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(res.statusCode !== 200 ? { error: parsed } : parsed);
                } catch (e) {
                    resolve({ error: data });
                }
            });
        });
        req.on('error', reject);
        req.write(requestBody);
        req.end();
    });
}

function buildMessages(data) {
    const {
        subject, yearGroup, examBoard, totalMarks, timeAllowed, paperName,
        examQuestion, sourceMaterial, sourceFiles, markScheme, markSchemeFile,
        additionalNotes, minWords, targetWords, maxAttempts, teacherPassword,
        gradeBoundaries, includeGradeDescriptors
    } = data;

    const content = [];

    // Add source files
    if (sourceFiles?.length > 0) {
        for (const file of sourceFiles) {
            if (file.type === 'application/pdf') {
                content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.content } });
                content.push({ type: 'text', text: `[Source file: ${file.name}]` });
            } else if (file.type?.startsWith('image/')) {
                content.push({ type: 'image', source: { type: 'base64', media_type: file.type, data: file.content } });
                content.push({ type: 'text', text: `[Image: ${file.name}]` });
            }
        }
    }

    // Add mark scheme file
    if (markSchemeFile?.type === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: markSchemeFile.content } });
        content.push({ type: 'text', text: `[Mark scheme: ${markSchemeFile.name}]` });
    }

    const hasGradeBoundaries = gradeBoundaries && gradeBoundaries.length > 0;

    // Build grade boundaries section for prompt
    let gradeBoundariesSection = '';
    if (hasGradeBoundaries) {
        gradeBoundariesSection = `\n## GRADE BOUNDARIES (PROVIDED BY TEACHER)\n`;
        gradeBoundariesSection += `The following grade boundaries have been provided:\n`;
        gradeBoundaries.forEach(b => {
            gradeBoundariesSection += `- Grade ${b.grade}: ${b.minMarks || '?'}-${b.maxMarks || '?'} marks\n`;
        });
        
        gradeBoundariesSection += `\n**IMPORTANT INSTRUCTIONS FOR GRADE BOUNDARIES:**\n`;
        gradeBoundariesSection += `1. You MUST interpolate any missing grades between the provided boundaries\n`;
        gradeBoundariesSection += `2. For example, if given Grade 9 (36-40), Grade 6 (24-28), and Grade 4 (16-20), you should also generate Grade 8, Grade 7, and Grade 5\n`;
        gradeBoundariesSection += `3. Calculate interpolated mark boundaries proportionally based on the gaps\n`;
        gradeBoundariesSection += `4. Generate descriptors for ALL grades (provided and interpolated)\n`;
        gradeBoundariesSection += `5. Each descriptor should be 2-3 sentences explaining what a response at that level demonstrates, directly referencing the mark scheme criteria\n`;
        gradeBoundariesSection += `6. Order grades from highest to lowest in the output\n`;
    }

    // Build the grading section of the config template
    let gradingSection = '';
    if (hasGradeBoundaries) {
        // When grade boundaries are provided, use them instead of generic gradingCriteria
        gradingSection = `
  // Grade boundaries with descriptors based on mark scheme
  gradeBoundaries: [
    // INTERPOLATE all grades between the provided boundaries
    // Include ALL grades from highest to lowest
    // Example format for each grade:
    {
      grade: "[grade name]",
      minMarks: [minimum marks for this grade],
      maxMarks: [maximum marks for this grade],
      descriptor: "[2-3 sentences describing what a response at this grade demonstrates, referencing specific mark scheme criteria]"
    }
    // ... repeat for all grades (provided AND interpolated)
  ]`;
    } else {
        // No grade boundaries - use the generic gradingCriteria
        gradingSection = `
  gradingCriteria: {
    content: { weight: 30, description: "[From mark scheme]" },
    analysis: { weight: 30, description: "[From mark scheme]" },
    structure: { weight: 20, description: "[From mark scheme]" },
    expression: { weight: 20, description: "[From mark scheme]" }
  }`;
    }

    const prompt = `You are an expert educational content designer. Create a guided essay writing configuration.

## EXAM INFORMATION
- Subject: ${subject || 'Not specified'}
- Year Group: ${yearGroup || 'Not specified'}
- Exam Board: ${examBoard || 'Not specified'}
- Total Marks: ${totalMarks || 'Not specified'}
- Time Allowed: ${timeAllowed ? timeAllowed + ' minutes' : 'Not specified'}
${paperName ? `- Paper: ${paperName}` : ''}

## EXAM QUESTION
${examQuestion || 'No question provided'}

${sourceMaterial ? `## SOURCE MATERIAL\n${sourceMaterial}\n` : ''}

## MARK SCHEME
${markScheme || 'No mark scheme provided - create appropriate criteria for this subject.'}
${gradeBoundariesSection}
${additionalNotes ? `## TEACHER NOTES\n${additionalNotes}\n` : ''}

## CONFIGURATION SETTINGS
- Min words/paragraph: ${minWords || 80}
- Target words/paragraph: ${targetWords || 150}
- Max attempts: ${maxAttempts || 3}
- Teacher password: ${teacherPassword || 'teacher123'}

## DIFFERENTIATED LEARNING MATERIALS
You MUST create learning materials at THREE difficulty tiers for EACH paragraph:
1. **Foundation** (GCSE 1-4 / A-Level D-E): Simplified language, step-by-step scaffolding, basic vocabulary, focus on meeting minimum mark scheme criteria (Level 1-2 descriptors)
2. **Intermediate** (GCSE 5-6 / A-Level C-B): Balanced guidance, some analytical depth, moderate vocabulary, targeting middle mark scheme bands (Level 2-3 descriptors)
3. **Advanced** (GCSE 7-9 / A-Level A*-A): Sophisticated techniques, nuanced analysis, ambitious vocabulary, examiner insights, targeting top band criteria (Level 3-4 descriptors)

Use the mark scheme level descriptors to inform what each tier should emphasise. For example:
- If the mark scheme mentions "simple awareness" at Level 1, foundation material should help achieve this
- If it mentions "compelling, convincing communication" at Level 4, advanced material should target this

## IMPORTANT FORMATTING RULES
- Use ONLY plain ASCII characters - no special symbols, checkmarks, emojis, or accented characters
- Use simple dashes (-) or asterisks (*) for bullet points
- Avoid curly quotes - use straight quotes only
- The essay ID should be lowercase with hyphens (e.g., 'creative-writing-sunset')
${hasGradeBoundaries ? `- CRITICAL: You MUST interpolate missing grades and include ALL grades from highest to lowest
- Each grade descriptor must specifically reference the mark scheme criteria provided above` : ''}

## TASK
Generate a complete essay configuration with 4-6 paragraphs. Output ONLY valid JavaScript using this EXACT format:

**CRITICAL: TIERED LEARNING MATERIALS**
Each paragraph MUST include learningMaterial as an OBJECT with THREE tiers, NOT a single string:
- foundation: For GCSE grades 1-4 or A-Level grades D/E - simpler language, more scaffolding, basic sentence starters, focus on meeting minimum requirements
- intermediate: For GCSE grades 5-6 or A-Level grades C/B - balanced guidance, some sophistication, moderate challenge
- advanced: For GCSE grades 7-9 or A-Level grades A/A* - sophisticated techniques, nuanced analysis, ambitious vocabulary, examiner-level insights

Base the differentiation on the mark scheme levels - foundation material should help students achieve lower band criteria, intermediate for middle bands, and advanced for top band criteria.

\`\`\`javascript
window.ESSAYS = window.ESSAYS || {};
window.ESSAYS['[essay-id-here]'] = {
  id: '[essay-id-here]',
  title: "[Title for this essay task]",
  subject: "${subject || 'Subject'}",
  yearGroup: "${yearGroup || 'Year'}",
  totalMarks: ${totalMarks || 40},
  essayTitle: "[The exam question]",
  instructions: "[Clear instructions for students]",
  originalTask: \`## Exam Question
[Full question]

## Mark Scheme Summary
[Key criteria]\`,
  // Source material that students should reference (text extracts, passages, data, etc.)
  sourceMaterial: \`[Include the full source material text here that students need to reference. This should be the exact text/data provided in the exam.]\`,
  // Source images array - will be populated with base64 data for maps, diagrams, pictures etc.
  sourceImages: [
    // Images will be injected here as: { name: "filename.jpg", caption: "Description", data: "base64..." }
  ],
  maxAttempts: ${maxAttempts || 3},
  minWordsPerParagraph: ${minWords || 80},
  targetWordsPerParagraph: ${targetWords || 150},
  teacherPassword: "${teacherPassword || 'teacher123'}",
  paragraphs: [
    {
      id: 1,
      title: "Introduction",
      type: "introduction",
      learningMaterial: {
        foundation: \`## Writing Your Introduction (Foundation)

[Clear, accessible guidance with simple steps...]

### What You Need to Include
- [Basic point 1 in simple terms]
- [Basic point 2 in simple terms]

### Helpful Sentence Starters
- "This essay will explore..."
- "The main idea is..."
\`,
        intermediate: \`## Writing Your Introduction (Intermediate)

[More detailed guidance with some sophistication...]

### Key Elements to Include
- [Point 1 with more detail]
- [Point 2 with analytical focus]

### Sentence Starters
- "This essay will argue that..."
- "By examining [X], it becomes clear that..."
\`,
        advanced: \`## Writing Your Introduction (Advanced)

[Sophisticated guidance focusing on top-band criteria...]

### Crafting a Compelling Opening
- [Advanced technique 1]
- [Nuanced analytical approach]

### Ambitious Openings
- "Through a nuanced examination of..."
- "The complex interplay between..."
\`
      },
      writingPrompt: "[Clear instruction]",
      keyPoints: ["[Mark scheme criterion]"],
      exampleQuotes: []
    },
    // More body paragraphs - EACH must have learningMaterial as an object with foundation, intermediate, advanced keys
    {
      id: [n],
      title: "Conclusion",
      type: "conclusion",
      learningMaterial: {
        foundation: \`## Writing Your Conclusion (Foundation)
[Simple, clear guidance...]
\`,
        intermediate: \`## Writing Your Conclusion (Intermediate)
[Balanced guidance...]
\`,
        advanced: \`## Writing Your Conclusion (Advanced)
[Sophisticated guidance...]
\`
      },
      writingPrompt: "[Instruction]",
      keyPoints: ["[Criterion]"],
      exampleQuotes: []
    }
  ],${gradingSection}
};
\`\`\`

REMEMBER: Every paragraph's learningMaterial MUST be an object with foundation, intermediate, and advanced keys - NOT a string.

Generate the complete configuration using ONLY plain ASCII characters:`;

    content.push({ type: 'text', text: prompt });
    return [{ role: 'user', content }];
}

function extractJavaScript(text) {
    const match = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const configMatch = text.match(/(window\.ESSAY_CONFIG[\s\S]*};?)/);
    if (configMatch) return configMatch[1].trim();
    return text.trim();
}

function injectSourceContent(config, body) {
    const { sourceMaterial, sourceFiles } = body;
    
    // Escape special characters for JavaScript template literal
    function escapeForTemplateLiteral(str) {
        if (!str) return '';
        return str
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
    }
    
    // Inject source material text
    if (sourceMaterial && sourceMaterial.trim()) {
        const escapedMaterial = escapeForTemplateLiteral(sourceMaterial.trim());
        // Replace the placeholder with actual content
        config = config.replace(
            /sourceMaterial:\s*`\[Include the full source material text here[^\`]*\]`/,
            `sourceMaterial: \`${escapedMaterial}\``
        );
    } else {
        // No source material - set to empty string
        config = config.replace(
            /sourceMaterial:\s*`\[Include the full source material text here[^\`]*\]`/,
            `sourceMaterial: \`\``
        );
    }
    
    // Inject source images
    if (sourceFiles && sourceFiles.length > 0) {
        const imageObjects = sourceFiles
            .filter(f => f.type && f.type.startsWith('image/') && f.content)
            .map(f => ({
                name: f.name,
                type: f.type,
                caption: f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
                data: f.content
            }));
        
        if (imageObjects.length > 0) {
            const imagesArrayStr = JSON.stringify(imageObjects, null, 4)
                .split('\n')
                .map((line, i) => i === 0 ? line : '  ' + line)
                .join('\n');
            
            config = config.replace(
                /sourceImages:\s*\[\s*\/\/[^\]]*\]/,
                `sourceImages: ${imagesArrayStr}`
            );
        }
    }
    
    return config;
}
