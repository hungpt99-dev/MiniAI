import type { Tool } from '../types';
import { clipboardWriteText } from './clipboard';

export const clipboardWriteTool: Tool = {
  name: 'clipboard_write',
  description: 'Write text to the clipboard.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to copy' },
    },
    required: ['text'],
  },
  risk: 'write',
  askSafe: false,
  describe: (input) => `Write ${String(input.text || '').length} chars to clipboard`,
  run: async (input) => clipboardWriteText(String(input.text || '')),
};
