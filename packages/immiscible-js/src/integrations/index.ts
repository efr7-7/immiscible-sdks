/** Every framework integration, from one entry point (`@immiscible/sdk/integrations`). */

export { gated, refusalMessage, defaultMapToAction, parseArgs, clientOf } from './core.js';
export type { IntegrationOptions, MapToAction, ToolCallInfo } from './core.js';
export { guardOpenAITool, guardOpenAITools, openaiToolGuardrail } from './openai-agents.js';
export type { OpenAIFunctionToolLike } from './openai-agents.js';
export { guardLangChainTool, guardLangChainTools } from './langchain.js';
export type { LangChainToolLike } from './langchain.js';
export { guardAiTool, guardAiTools, immiscibleMiddleware } from './vercel-ai.js';
export type { AiToolLike, MiddlewareOptions } from './vercel-ai.js';
export { resolveInterruptions, hitlDecisions } from './approvals.js';
export type { ApprovalAdapterOptions, ResolvedCall, InterruptedResultLike, ToolApprovalItemLike, HitlRequestLike } from './approvals.js';
