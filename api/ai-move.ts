import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

// Vercel serverless execution duration limit
export const maxDuration = 300;

async function getRequestBody(req: any): Promise<any> {
  if (req.body) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    return req.body;
  }

  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: any) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {
      resolve({});
    });
  });
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await getRequestBody(req);
  const { legalMoves, boardSummary, capturedPieces, moveHistory, model } = body || {};

  if (!legalMoves || !Array.isArray(legalMoves) || legalMoves.length === 0) {
    return res.status(400).json({ error: 'No legal moves provided' });
  }

  // Allowed Free-tier models
  const allowedModels = ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
  const primaryModel = allowedModels.includes(model) ? model : 'gemini-flash-latest';

  // Build ordered list: try user's selected model first, then fallback to other free-tier models
  const modelsToTry = [
    primaryModel,
    ...allowedModels.filter((m) => m !== primaryModel),
  ];

  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.API_KEY ||
    process.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    return returnFallback(
      body,
      res,
      'APIキー未設定',
      '環境変数 GEMINI_API_KEY が設定されていません。'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const systemInstruction = `あなたは初心者を優しく導く将棋の師匠です。後手(△)として合法手一覧から最善の1手をインデックス番号(chosenIndex)で選び、初心者向けの温かい解説(comment: 40文字以内)をJSONで返してください。`;

  // Compact prompt format to minimize input tokens and latency
  const compactMoves = legalMoves
    .map((m: any, idx: number) => `[${idx}]${m.notation || ''}`)
    .join(' ');

  const promptText = `盤面:\n${boardSummary || ''}\n後手持駒:${capturedPieces || 'なし'}\n直近:${moveHistory ? moveHistory.slice(-4).join('→') : '初手'}\n合法手(0〜${legalMoves.length - 1}):\n${compactMoves}`;

  let lastError: any = null;

  for (const modelName of modelsToTry) {
    try {
      const config: any = {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.2,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chosenIndex: {
              type: Type.INTEGER,
              description: `0〜${legalMoves.length - 1}の整数`,
            },
            comment: {
              type: Type.STRING,
              description: '初心者への一言アドバイス(40文字以内)',
            },
          },
          required: ['chosenIndex', 'comment'],
        },
      };

      // Only pass thinkingConfig on gemini-3.8-flash (other models either default to minimal or reject thinkingLevel)
      if (modelName === 'gemini-3.8-flash') {
        config.thinkingConfig = {
          thinkingLevel: ThinkingLevel.LOW,
        };
      }

      const response = await ai.models.generateContent({
        model: modelName,
        contents: promptText,
        config,
      });

      const parsed = JSON.parse(response.text || '{}');
      const chosenIndex =
        typeof parsed.chosenIndex === 'number' &&
        parsed.chosenIndex >= 0 &&
        parsed.chosenIndex < legalMoves.length
          ? parsed.chosenIndex
          : 0;

      const chosenMove = legalMoves[chosenIndex];
      return res.status(200).json({
        move: chosenMove,
        comment: parsed.comment || '落ち着いて次の手を考えましょう！',
        source: 'gemini',
        modelUsed: modelName,
      });
    } catch (err: any) {
      console.warn(`Model ${modelName} error:`, err?.message);
      lastError = err;

      // If error is 402 (Prepayment credits depleted on the project itself), all models on this key will return 402, so break early
      const msg = String(err?.message || '');
      if (msg.includes('"code":402') || msg.includes('prepayment credits are depleted')) {
        break;
      }
    }
  }

  // Accurately classify the error instead of lumping everything into 429
  const errMsg = String(lastError?.message || '');
  let shortReason = '通信エラー';
  let userFriendlyDetail = errMsg;

  if (errMsg.includes('"code":402') || errMsg.includes('prepayment credits are depleted')) {
    shortReason = 'クレジット残高不足(402)';
    userFriendlyDetail =
      'APIキーのプロジェクトが前払い(Prepay)設定になっており残高が0です。Google AI Studioで課金設定のない新規プロジェクトで無料枠APIキーを発行するか、クレジットをチャージしてください。';
  } else if (errMsg.includes('limit: 0') || errMsg.includes('limit:0')) {
    shortReason = '無料枠対象外モデル(limit:0)';
    userFriendlyDetail =
      '選択されたモデルが現在のAPIキーの無料枠で許可されていません（limit: 0）。別のモデルを選択するか、Google AI Studioのプロジェクト設定をご確認ください。';
  } else if (errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('demand')) {
    shortReason = 'Google側一時混雑(503)';
    userFriendlyDetail = 'GoogleのGeminiサーバーが一時的に混雑しています。';
  } else if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota')) {
    shortReason = 'APIレート制限(429)';
    userFriendlyDetail = '短時間のリクエスト上限（RPM）または1日の上限（RPD）に達しました。';
  } else if (errMsg.includes('404') || errMsg.includes('NOT_FOUND')) {
    shortReason = 'モデル未対応(404)';
    userFriendlyDetail = '指定されたモデル名が現在のAPIエンドポイントで見つかりませんでした。';
  } else if (errMsg.includes('400') || errMsg.includes('INVALID_ARGUMENT')) {
    shortReason = 'リクエストエラー(400)';
    userFriendlyDetail = 'APIリクエストのパラメータまたはキーが無効です。';
  } else if (errMsg.includes('timeout') || errMsg.includes('504')) {
    shortReason = '応答時間超過(504)';
    userFriendlyDetail = 'AIの応答がタイムアウトしました。';
  }

  return returnFallback(body, res, shortReason, userFriendlyDetail);
}

function returnFallback(body: any, res: any, shortReason: string, rawDetail: string) {
  const legalMoves = body?.legalMoves || [];
  if (!legalMoves.length) {
    return res.status(500).json({ error: 'No legal moves', fallbackNeeded: true });
  }

  let bestMove = legalMoves[0];
  let bestScore = -9999;
  legalMoves.forEach((m: any) => {
    let score = Math.random() * 5;
    if (m.promote) score += 20;
    if (m.type === 'move') {
      if (m.to && (m.to[0] === 4 || m.to[1] === 4)) score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  });

  const comments = [
    '歩を進めて陣形を整えます。序盤は駒の活用が大切ですよ！',
    '駒を前進させて中央の制圧を狙います。慌てず受けてみてくださいね。',
    '角や飛車の利きに注意しながら、じっくり攻めを組み立てましょう。',
    '王様の守りも意識しながら、攻めの隙を伺っています。',
  ];
  const chosenComment = comments[Math.floor(Math.random() * comments.length)];

  return res.status(200).json({
    move: bestMove,
    comment: chosenComment,
    source: 'heuristic-fallback',
    fallbackReason: shortReason,
    notice: rawDetail,
  });
}
