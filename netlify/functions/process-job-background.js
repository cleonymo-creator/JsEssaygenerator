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

        const config = extractJavaScript(claudeData.content[0].text);
        console.log('Config generated, length:', config.length);

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
        additionalNotes, minWords, targetWords, maxAttempts, teacherPassword
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

    const prompt = `You are an expert educational content designer. Create a guided essay writing configuration compatible with a holistic grading system.

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

${additionalNotes ? `## TEACHER NOTES\n${additionalNotes}\n` : ''}

## CONFIGURATION SETTINGS
- Min words/paragraph: ${minWords || 80}
- Target words/paragraph: ${targetWords || 150}
- Max attempts: ${maxAttempts || 3}
- Teacher password: ${teacherPassword || 'teacher123'}

## IMPORTANT FORMATTING RULES
- Use ONLY plain ASCII characters - no special symbols, checkmarks, or accented characters
- Use simple dashes (-) or asterisks (*) for bullet points
- Avoid curly quotes - use straight quotes only
- The essay ID should be lowercase with hyphens (e.g., 'macbeth-ambition-essay')
- For icon field, use a simple emoji that represents the subject/topic

## HOLISTIC GRADING SYSTEM
This system uses holistic assessment - DO NOT include "points" fields in paragraphs.
Instead, provide rich grade descriptors in officialMarkScheme if this is an exam-based task.

## TASK
Generate a complete essay configuration with 4-6 paragraphs. Output ONLY valid JavaScript using this EXACT format:

\`\`\`javascript
window.ESSAYS = window.ESSAYS || {};
window.ESSAYS['[essay-id-here]'] = {
  // === REQUIRED CORE FIELDS ===
  id: '[essay-id-here]',
  title: "[Short title for this essay task]",
  subject: "${subject || 'Subject'}",
  yearGroup: "${yearGroup || 'Year'}",
  description: "[Brief one-line description shown on selection screen]",
  icon: "📝", // Choose appropriate emoji for the topic
  
  // === ESSAY QUESTION & INSTRUCTIONS ===
  essayTitle: "[The main essay question students will answer]",
  instructions: "[Clear instructions shown to students at the start]",
  
  // === ORIGINAL TASK (shown in right panel) ===
  originalTask: \`## Exam Question

[Full exam question as students would see it]

${examBoard ? '**Exam Board**: ' + examBoard : ''}
${totalMarks ? '**Total Marks**: ' + totalMarks : ''}
${timeAllowed ? '**Time Allowed**: ' + timeAllowed + ' minutes' : ''}

### Assessment Objectives:
- [Assessment objective 1 from mark scheme]
- [Assessment objective 2 from mark scheme]

### What to include:
- [Key requirement 1]
- [Key requirement 2]
- [Key requirement 3]\`,
  
  // === GLOBAL SOURCE MATERIAL (optional but recommended) ===
  // Include this if there's context/background that applies to the whole essay
  ${sourceMaterial ? `sourceMaterial: \`## Background Information

[Relevant context that students should consider throughout their essay]

### Key Facts:
- [Important contextual point 1]
- [Important contextual point 2]

### Relevant Information:
[Any quotes, data, or background material that applies to the whole essay]\`,` : '// sourceMaterial: `## Background\\n[Add global context if needed]`,'}
  
  // === WRITING CONSTRAINTS ===
  maxAttempts: ${maxAttempts || 3},
  minWordsPerParagraph: ${minWords || 80},
  targetWordsPerParagraph: ${targetWords || 150},
  teacherPassword: "${teacherPassword || 'teacher123'}",
  
  // === PARAGRAPHS ARRAY ===
  paragraphs: [
    {
      id: "intro",
      title: "Introduction",
      type: "introduction",
      
      learningMaterial: \`## Writing Your Introduction

[Detailed, specific guidance for writing an introduction for THIS essay]

### Key Points to Cover:
- [Specific point 1 relevant to this essay question]
- [Specific point 2]
- [Specific point 3]

### Structure Tips:
- [Structural advice 1]
- [Structural advice 2]

### Sentence Starters:
- "[Relevant starter for this topic]..."
- "[Another option]..."\`,
      
      writingPrompt: "[Clear instruction about what to write in the introduction]",
      
      keyPoints: [
        "[Key point 1 to address in introduction]",
        "[Key point 2]",
        "[Key point 3]"
      ],
      
      exampleQuotes: [] // Usually empty for introductions
      
      // Optional: Add paragraph-specific sourceMaterial only if needed
      // sourceMaterial: \`## Introduction Resources\\n[Specific material for intro]\`
    },
    
    // Body paragraph 1
    {
      id: "para1",
      title: "[Title for first body paragraph]",
      type: "body",
      
      learningMaterial: \`## [Paragraph topic]

[Detailed teaching content for this paragraph]

### Key Analysis Points:
- [Analysis point 1]
- [Analysis point 2]

### Evidence to Use:
- [What evidence/quotes to include]

### Techniques to Discuss:
- [Technique 1 and its effect]
- [Technique 2 and its effect]\`,
      
      writingPrompt: "[Instruction for what to write in this paragraph]",
      
      keyPoints: [
        "[Key point 1 for this paragraph]",
        "[Key point 2]",
        "[Key point 3]"
      ],
      
      exampleQuotes: [
        "[Relevant quote 1]",
        "[Relevant quote 2]"
      ],
      
      // If this paragraph needs specific source material (extract, data, etc.):
      sourceMaterial: \`## [Title for source material]

[Specific extract, passage, data, or context for THIS paragraph]

### Analysis Guidance:
- [What to look for in this material]
- [Key points to analyze]

### Key Vocabulary:
- [Term 1]: [definition]
- [Term 2]: [definition]\`
    },
    
    // Additional body paragraphs (2-4 total body paragraphs)...
    
    {
      id: "conclusion",
      title: "Conclusion",
      type: "conclusion",
      
      learningMaterial: \`## Writing Your Conclusion

[Guidance for writing a strong conclusion]

### What to Include:
- [Summary requirement]
- [Final evaluation requirement]
- [Link back to question]

### Avoid:
- Introducing new points
- Simply repeating introduction
- Ending abruptly\`,
      
      writingPrompt: "[Instruction for conclusion]",
      
      keyPoints: [
        "[Summary point]",
        "[Final evaluation]",
        "[Link to question/context]"
      ],
      
      exampleQuotes: [] // Usually empty for conclusions
    }
  ],
  
  // === GRADING CRITERIA (must sum to 100) ===
  gradingCriteria: {
    content: { 
      weight: 30, 
      description: "[What counts as good content - based on mark scheme]" 
    },
    analysis: { 
      weight: 30, 
      description: "[What counts as good analysis - based on mark scheme]" 
    },
    structure: { 
      weight: 20, 
      description: "[What counts as good structure - based on mark scheme]" 
    },
    expression: { 
      weight: 20, 
      description: "[What counts as good expression - based on mark scheme]" 
    }
  }${totalMarks && totalMarks >= 20 ? `,
  
  // === OFFICIAL MARK SCHEME (include if exam-based question) ===
  officialMarkScheme: {
    totalMarks: ${totalMarks || 30},
    gradeBoundaries: [
      {
        grade: "9",
        minMarks: [calculate: ~85-90% of total],
        maxMarks: ${totalMarks || 30},
        descriptor: "[Detailed grade 9 descriptor from the mark scheme - what excellence looks like]"
      },
      {
        grade: "8",
        minMarks: [calculate: ~75-84% of total],
        maxMarks: [one less than grade 9 min],
        descriptor: "[Detailed grade 8 descriptor from mark scheme]"
      },
      {
        grade: "7",
        minMarks: [calculate: ~65-74% of total],
        maxMarks: [one less than grade 8 min],
        descriptor: "[Detailed grade 7 descriptor from mark scheme]"
      },
      {
        grade: "6",
        minMarks: [calculate: ~55-64% of total],
        maxMarks: [one less than grade 7 min],
        descriptor: "[Detailed grade 6 descriptor from mark scheme]"
      },
      {
        grade: "5",
        minMarks: [calculate: ~45-54% of total],
        maxMarks: [one less than grade 6 min],
        descriptor: "[Detailed grade 5 descriptor from mark scheme]"
      },
      {
        grade: "4",
        minMarks: [calculate: ~35-44% of total],
        maxMarks: [one less than grade 5 min],
        descriptor: "[Detailed grade 4 descriptor from mark scheme]"
      }
    ]
  }` : ''}
};
\`\`\`

## CRITICAL REQUIREMENTS:
1. DO NOT include "points: X" in any paragraph objects
2. DO include detailed sourceMaterial at paragraph level if students need specific extracts/passages
3. DO include originalTask with clear markdown formatting
4. DO make learningMaterial specific and detailed for each paragraph
5. DO include officialMarkScheme with holistic grade descriptors if this is exam-based
6. Ensure all text uses plain ASCII characters only
7. Make the essay configuration rich, detailed, and educationally valuable

Generate the complete configuration now:`;

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
