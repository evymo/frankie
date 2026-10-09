'use strict';
/** Schémata strukturovaných výstupů AI. Každý výstup modelu se validuje dřív, než ho použije algoritmus. */
const { ASPECT_IDS, PRIORITIES, TASK_TYPES, OPERATION_CATEGORIES, DATA_SENSITIVITY } = require('./aspects');

const CHECK_TYPES = [
  'nonempty', 'json_valid', 'json_schema', 'json_equals', 'contains', 'not_contains', 'regex',
  'number_equals', 'max_words', 'min_words', 'code_artifact_present', 'js_function_tests', 'semantic',
];

const RELATIONS = ['EQUIVALENT', 'NONCRITICAL_DIFFERENCE', 'CRITICAL_CONFLICT', 'UNCLEAR'];

const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };

const goalComponents = {
  type: 'object',
  required: ['action', 'object', 'deliverable'],
  properties: { action: str, object: str, deliverable: str, qualities: strArr },
};

const aspectReport = {
  type: 'object',
  required: ['id', 'finding', 'priority', 'priorityRationale', 'evidence', 'assumptions', 'unknowns', 'missingInfo', 'recommendation'],
  properties: {
    id: { type: 'string', enum: ASPECT_IDS },
    finding: { type: 'string', minLength: 1 },
    priority: { type: 'string', enum: PRIORITIES },
    priorityRationale: str,
    evidence: strArr,
    assumptions: strArr,
    unknowns: strArr,
    missingInfo: { type: 'array', items: { type: 'object', required: ['item', 'critical'], properties: { item: str, critical: { type: 'boolean' } } } },
    recommendation: str,
    scope: str,
    nonGoals: strArr,
    contradictions: strArr,
    dependencies: strArr,
    dataSensitivity: { type: 'string', enum: DATA_SENSITIVITY },
  },
};

const GATE0 = {
  type: 'object',
  required: ['taskType', 'aspects', 'h1Goal', 'requiredCapabilities', 'requestedOperations', 'toolCandidates', 'injectionSuspected'],
  properties: {
    taskType: { type: 'string', enum: TASK_TYPES },
    aspects: { type: 'array', minItems: 10, maxItems: 10, items: aspectReport },
    h1Goal: { type: 'object', required: ['statement', 'components'], properties: { statement: { type: 'string', minLength: 1 }, components: goalComponents } },
    requiredCapabilities: strArr,
    requestedOperations: { type: 'array', items: { type: 'object', required: ['operation', 'category'], properties: { operation: str, category: { type: 'string', enum: OPERATION_CATEGORIES } } } },
    toolCandidates: { type: 'array', items: { type: 'object', required: ['tool', 'input', 'fullySolves'], properties: { tool: str, input: str, fullySolves: { type: 'boolean' } } } },
    injectionSuspected: { type: 'boolean' },
  },
};

const criterionProposal = {
  type: 'object',
  required: ['description', 'mandatory', 'check'],
  properties: {
    description: { type: 'string', minLength: 1 },
    mandatory: { type: 'boolean' },
    check: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: CHECK_TYPES }, params: { type: 'object' } } },
  },
};

const GOAL_AUDIT = {
  type: 'object',
  required: ['derivable', 'confidence', 'statement', 'components', 'evidence', 'assumptions', 'scope', 'nonGoals', 'constraints', 'expectedOutput', 'acceptanceCriteria', 'uncertainties', 'alternatives'],
  properties: {
    derivable: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    statement: str,
    components: goalComponents,
    evidence: strArr,
    assumptions: strArr,
    scope: str,
    nonGoals: strArr,
    constraints: strArr,
    expectedOutput: { type: 'object', required: ['format', 'description'], properties: { format: { type: 'string', enum: ['text', 'markdown', 'json', 'number', 'code', 'other'] }, description: str } },
    acceptanceCriteria: { type: 'array', items: criterionProposal },
    explicitGoalCriteria: { type: 'array', items: criterionProposal },
    uncertainties: strArr,
    alternatives: { type: 'array', items: { type: 'object', required: ['statement'], properties: { statement: str, why: str } } },
  },
};

const GOAL_COMPARE = {
  type: 'object',
  required: ['pairs'],
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['pair', 'relation', 'differences', 'rationale'],
        properties: {
          pair: { type: 'string', enum: ['explicit_vs_audit', 'explicit_vs_h1', 'h1_vs_audit'] },
          relation: { type: 'string', enum: RELATIONS },
          differences: { type: 'array', items: { type: 'object', required: ['description', 'critical'], properties: { description: str, critical: { type: 'boolean' } } } },
          rationale: str,
        },
      },
    },
  },
};

const EXECUTION = {
  type: 'object',
  required: ['status', 'output', 'outputFormat', 'artifacts', 'completedOperations', 'blockedOperations', 'assumptionsUsed', 'criteriaSelfReport'],
  properties: {
    status: { type: 'string', enum: ['completed', 'partial', 'blocked', 'unsupported'] },
    output: str,
    outputFormat: { type: 'string', enum: ['text', 'markdown', 'json', 'number', 'code', 'other'] },
    artifacts: { type: 'array', items: { type: 'object', required: ['name', 'type', 'content'], properties: { name: str, type: { type: 'string', enum: ['code', 'data', 'text'] }, language: str, content: str } } },
    completedOperations: strArr,
    blockedOperations: { type: 'array', items: { type: 'object', required: ['operation', 'reason'], properties: { operation: str, reason: str } } },
    assumptionsUsed: strArr,
    criteriaSelfReport: { type: 'array', items: { type: 'object', required: ['criterionId', 'met'], properties: { criterionId: str, met: { type: 'string', enum: ['yes', 'no', 'unknown'] }, note: str } } },
    notes: str,
  },
};

const SEMANTIC_VERIFY = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterionId', 'result', 'evidence', 'deviation'],
        properties: { criterionId: str, result: { type: 'string', enum: ['PASS', 'FAIL', 'UNVERIFIED'] }, evidence: str, deviation: str },
      },
    },
  },
};

const BASELINE = {
  type: 'object',
  required: ['output'],
  properties: { output: str, artifacts: EXECUTION.properties.artifacts },
};

module.exports = { CHECK_TYPES, RELATIONS, GATE0, GOAL_AUDIT, GOAL_COMPARE, EXECUTION, SEMANTIC_VERIFY, BASELINE };
