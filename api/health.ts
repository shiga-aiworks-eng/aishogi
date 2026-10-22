export default function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Check multiple common environment variable names in case the user named it differently in Vercel
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.API_KEY ||
    process.env.VITE_GEMINI_API_KEY;

  res.status(200).json({
    status: 'ok',
    hasApiKey: !!apiKey,
    envFound: !!apiKey,
    envName: apiKey
      ? (process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : (process.env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' : 'API_KEY'))
      : null,
    nodeEnv: process.env.NODE_ENV || 'production',
  });
}
