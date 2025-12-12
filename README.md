# Essay Config Generator

A user-friendly web application that transforms exam questions and mark schemes into structured essay writing configurations for students.

## Features

- **Step-by-step wizard** - Guides teachers through entering exam details
- **PDF upload support** - Upload mark schemes and source materials
- **AI-powered generation** - Uses Claude to create intelligent, mark-scheme-aligned configurations
- **Instant download** - Get your `essay.js` file ready to use

## Deployment to Netlify

### Quick Deploy

1. **Push to GitHub** - Create a new repository and push this folder
2. **Connect to Netlify**:
   - Go to [netlify.com](https://netlify.com) and sign in
   - Click "Add new site" → "Import an existing project"
   - Connect your GitHub repository
3. **Configure environment variable**:
   - Go to Site settings → Environment variables
   - Add: `ANTHROPIC_API_KEY` = your Claude API key
4. **Deploy** - Netlify will automatically build and deploy

### Manual Deploy

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Deploy (from project directory)
netlify deploy --prod
```

Then add your `ANTHROPIC_API_KEY` in the Netlify dashboard under Site settings → Environment variables.

## Project Structure

```
essay-config-generator/
├── index.html              # Main application
├── netlify.toml            # Netlify configuration
├── netlify/
│   └── functions/
│       └── generate-config.mjs  # Serverless function for AI generation
└── README.md
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude |

## Usage

1. Visit your deployed site
2. Fill in exam details (subject, year group, marks, time)
3. Enter or paste the exam question
4. Add source material if applicable (text or PDF)
5. Provide the mark scheme (paste or upload PDF)
6. Configure word counts and attempts
7. Click "Generate Configuration"
8. Download the generated `essay.js` file
9. Save as `config/essay.js` in your essay writing app

## How It Works

The application sends exam details to a Netlify serverless function, which:

1. Constructs a detailed prompt with all exam information
2. Calls the Claude API to analyse the question and mark scheme
3. Generates a structured configuration with:
   - Logical paragraph breakdown
   - Learning material for each section
   - Mark scheme-aligned key points
   - Vocabulary and sentence starters
   - Appropriate mark distribution

## Customisation

After generating a configuration, you may want to:

- Adjust paragraph count or structure
- Modify word count targets
- Add additional example quotes
- Fine-tune the learning material
- Update grading criteria weights

Simply edit the downloaded `essay.js` file before deploying.

## Troubleshooting

**"API error" when generating**
- Check that `ANTHROPIC_API_KEY` is set correctly in Netlify
- Ensure your API key has sufficient credits

**PDF not being processed**
- Currently, PDF content is noted but not extracted
- For best results, paste mark scheme text directly

**Generated config has issues**
- Review and edit the downloaded file
- Regenerate with more specific additional notes

## Support

For issues with:
- This generator: Open a GitHub issue
- The essay writing app: See the main app documentation
- Claude API: Visit [anthropic.com/support](https://anthropic.com/support)
