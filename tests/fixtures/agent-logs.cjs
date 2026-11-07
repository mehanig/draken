const at = '2026-01-02T03:04:05.000Z';
exports.at = at;
exports.codexLog = (id = 'shared', cwd = '/synthetic/codex') => [
  { type: 'session_meta', timestamp: at, payload: { id, cwd, cli_version: 'synthetic', originator: 'codex_cli_rs', base_instructions: { text: 'PRIVATE_SYSTEM_INSTRUCTIONS' } } },
  { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please check the parser.' }] } },
  { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'Please check the parser.' } },
  { type: 'response_item', timestamp: at, payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE_THINKING' }], encrypted_content: 'PRIVATE_SIGNATURE' } },
  { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_DEVELOPER_CONTEXT' }] } },
  { type: 'response_item', timestamp: at, payload: { type: 'function_call', call_id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: '/synthetic/parser.ts', content: 'PRIVATE_WRITE_BODY' }) } },
  { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'call-1', output: 'Local check failed; deployment NOT checked.' } },
  { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Parser change reported. Deployment NOT checked.' }] } },
  { type: 'event_msg', timestamp: at, payload: { type: 'agent_message', message: 'Parser change reported. Deployment NOT checked.' } },
  { type: 'compacted', timestamp: at, payload: { message: 'Background compression, not new work.' } },
];
exports.claudeLog = (id = 'shared', cwd = '/synthetic/claude', extra = {}) => [
  { type: 'file-history-snapshot', messageId: 'snapshot-only', snapshot: { ignored: true } },
  ...[
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Please check the parser.' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }, { type: 'tool_use', id: 'call-1', name: 'Write', input: { file_path: '/synthetic/parser.ts', content: 'PRIVATE_WRITE_BODY' } }] } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: [{ type: 'text', text: 'Local check failed; deployment NOT checked.' }] }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'Parser change reported. Deployment NOT checked.' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null, logicalParentUuid: 'a2' },
    { type: 'user', uuid: 'summary', parentUuid: 'compact', isCompactSummary: true, message: { role: 'user', content: 'Background compression, not new work.' } },
  ].map(row => ({ ...row, timestamp: at, sessionId: id, cwd, version: 'synthetic', isSidechain: false, ...extra })),
];
