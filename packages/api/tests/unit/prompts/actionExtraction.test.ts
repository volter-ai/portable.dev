/**
 * Tests for Action Extraction Prompt Generation
 *
 * Ensures the Gemini action extraction prompt is correctly formatted
 * and includes all necessary instructions for action parsing.
 */

import { describe, it, expect } from 'bun:test';
import { getGeminiActionExtractionPrompt } from '../../../src/prompts/actionExtraction';

describe('getGeminiActionExtractionPrompt', () => {
  it('should return a string prompt', () => {
    const textContent = 'Would you like me to add tests or create documentation?';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should include the provided text content in the prompt', () => {
    const textContent = 'Would you like me to add tests or create documentation?';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain(textContent);
    expect(prompt).toContain('Message: """');
  });

  it('should include JSON structure instructions', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('Return a JSON object with this EXACT structure:');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"actions"');
    expect(prompt).toContain('"quote"');
    expect(prompt).toContain('"label"');
    expect(prompt).toContain('"prompt"');
    expect(prompt).toContain('"actionType"');
  });

  it('should include action type selection rules', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('prefill_input');
    expect(prompt).toContain('send_message');
    expect(prompt).toContain('ACTION TYPE SELECTION - CRITICAL');
  });

  it('should include examples for VAGUE vs SPECIFIC actions', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('Example 1 - VAGUE:');
    expect(prompt).toContain('Example 3 - SPECIFIC:');
    expect(prompt).toContain('modify the aesthetics');
    expect(prompt).toContain('change it lighter');
  });

  it('should include future work extraction guidance', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('FUTURE WORK EXTRACTION:');
    expect(prompt).toContain('Find CHOICES or OPTIONS');
  });

  it('should include extraction rules (LOOK FOR, DO NOT extract)', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('LOOK FOR:');
    expect(prompt).toContain('DO NOT extract:');
    expect(prompt).toContain('Would you like me to');
    expect(prompt).toContain("I'll...");
  });

  it('should include critical context rule', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('CRITICAL RULE: Look at the ENTIRE message context');
  });

  it('should specify JSON-only output format', () => {
    const textContent = 'Test message';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain('IMPORTANT: Return ONLY valid JSON');
    expect(prompt).toContain('no markdown formatting or extra text');
  });

  it('should handle multi-line text content', () => {
    const textContent = `I've completed dark mode.
Would you like to modify the aesthetics or complete the merge?`;
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain(textContent);
    expect(prompt).toContain('Message: """');
  });

  it('should handle text with special characters', () => {
    const textContent = 'Would you like to change #1a1a1a (dark) to #f0f0f0 (light)?';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain(textContent);
    expect(prompt).toContain('#1a1a1a');
    expect(prompt).toContain('#f0f0f0');
  });

  it('should handle empty text content', () => {
    const textContent = '';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    // Should still return a valid prompt with all instructions
    expect(prompt).toContain('Message: """');
    expect(prompt).toContain('Return a JSON object');
    expect(typeof prompt).toBe('string');
  });

  it('should not modify or escape the text content', () => {
    const textContent = 'Test with "quotes" and \\backslashes\\ and $variables';
    const prompt = getGeminiActionExtractionPrompt(textContent);

    expect(prompt).toContain(textContent);
  });

  it('should maintain consistent structure across different inputs', () => {
    const prompts = [
      getGeminiActionExtractionPrompt('Short'),
      getGeminiActionExtractionPrompt(
        'A much longer message with multiple sentences. Should we proceed?'
      ),
      getGeminiActionExtractionPrompt(''),
    ];

    // All prompts should have similar structure
    prompts.forEach((prompt) => {
      expect(prompt).toContain('Message: """');
      expect(prompt).toContain('Return a JSON object');
      expect(prompt).toContain('ACTION TYPE SELECTION');
      expect(prompt).toContain('CRITICAL RULE');
    });
  });
});
