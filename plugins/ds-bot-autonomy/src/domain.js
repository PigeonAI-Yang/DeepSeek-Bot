import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const text = z.string().trim().min(1)
const target = z.object({
  botId: text,
  roomId: text.optional(),
  sessionId: text,
}).strict()
const authorizationRef = z.object({
  sessionId: text,
  turnStartSeq: z.number().int().nonnegative(),
  messageSeq: z.number().int().nonnegative(),
  messageId: text.optional(),
  authorizedAt: z.number().nonnegative(),
}).strict()
const goalRef = z.object({
  id: text,
  revision: z.number().int().positive(),
}).strict()
const delivery = z.object({
  id: text,
  state: z.enum(['intent', 'receipt', 'ambiguous']),
  receipt: z.object({
    exchangeId: text.optional(),
    messageId: text.optional(),
    sessionId: text,
  }).strict().optional(),
}).strict()

export const responsibilitySchema = z.object({
  id: text,
  target,
  objective: text,
  acceptance: text,
  authorizationRef,
  allowedScope: text,
  resources: z.array(text).default([]),
  stopped: z.boolean(),
  scheduleBindings: z.array(text),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict()

export const workItemSchema = z.object({
  id: text,
  responsibilityId: text.optional(),
  parentWorkItemId: text.optional(),
  objective: text,
  acceptance: text,
  target,
  origin: z.object({
    kind: z.enum(['human', 'schedule', 'dependency']),
    messageId: text.optional(),
    scheduleId: text.optional(),
    occurrenceAt: text.optional(),
    triggerText: z.string().optional(),
  }).strict(),
  returnAddress: z.object({
    botId: text.optional(),
    roomId: text.optional(),
    sessionId: text.optional(),
    exchangeId: text.optional(),
    audience: z.enum(['bot', 'user']).optional(),
  }).strict().optional(),
  triggerKey: text.optional(),
  nativeMessageId: text.optional(),
  dependencyWorkItemId: text.optional(),
  waitReason: text.optional(),
  questionId: text.optional(),
  dependencyExchangeId: text.optional(),
  dependencySessionId: text.optional(),
  authorizationRef,
  status: z.enum(['queued', 'activating', 'active', 'waiting', 'stopped', 'complete', 'blocked', 'delivery-ambiguous']),
  maxGoalRounds: z.number().int().positive(),
  consumedRounds: z.number().int().nonnegative(),
  goalRef: goalRef.optional(),
  stopGeneration: z.number().int().nonnegative(),
  resources: z.array(text),
  evidence: z.string().optional(),
  result: z.string().optional(),
  delivery,
  partMove: z.object({
    fromSessionId: text,
    toSessionId: text,
    goalRef,
    remainingRounds: z.number().int().nonnegative(),
  }).strict().optional(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict()

export const autonomyDomain = defineDomain({
  name: 'ds_bot_autonomy',
  version: 1,
  tables: {
    responsibilities: domainTable(responsibilitySchema),
    work_items: domainTable(workItemSchema),
  },
})
