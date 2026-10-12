export const IpcChannels = {
  chatStream: 'miniai:chat-stream',
  chatCancel: 'miniai:chat-cancel',
  getSettings: 'miniai:get-settings',
  setSettings: 'miniai:set-settings',
  setApiKey: 'miniai:set-api-key',
  testConnectivity: 'miniai:test-connectivity',
  listConversations: 'miniai:list-conversations',
  getMessages: 'miniai:get-messages',
  createConversation: 'miniai:create-conversation',
  deleteConversation: 'miniai:delete-conversation',
  listTemplates: 'miniai:list-templates',
  upsertTemplate: 'miniai:upsert-template',
  listWorkflows: 'miniai:list-workflows',
  runWorkflow: 'miniai:run-workflow',
  slashQuery: 'miniai:slash-query',
  slashResolve: 'miniai:slash-resolve',
} as const;
export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
