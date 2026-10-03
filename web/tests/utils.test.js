/**
 * Tests unitaires pour le module utils.js
 */

import { 
    parsePeremption, 
    daysUntil, 
    todayFR,
    parseNombreFR,
    round2,
    round4,
    parseBarcodes,
    formatBarcodes,
    mergeBarcodes,
    matchesBarcode,
    escapeHtml
} from '../js/core/utils.js';

describe('Utils Module Tests', () => {
    
    describe('parsePeremption', () => {
        test('should parse single date in DD/MM/YYYY format', () => {
            const date = parsePeremption('31/12/2026');
            expect(date).toBeInstanceOf(Date);
            expect(date.getDate()).toBe(31);
            expect(date.getMonth()).toBe(11); // Décembre = 11
            expect(date.getFullYear()).toBe(2026);
        });
        
        test('should parse single date in YYYY-MM-DD format', () => {
            const date = parsePeremption('2026-12-31');
            expect(date).toBeInstanceOf(Date);
            expect(date.getDate()).toBe(31);
            expect(date.getMonth()).toBe(11);
            expect(date.getFullYear()).toBe(2026);
        });
        
        test('should return closest date from multiple dates', () => {
            const date = parsePeremption('31/12/2026, 15/06/2025, 01/01/2027');
            expect(date).toBeInstanceOf(Date);
            expect(date.getFullYear()).toBe(2025);
            expect(date.getMonth()).toBe(5); // Juin = 5
        });
        
        test('should return null for empty string', () => {
            const date = parsePeremption('');
            expect(date).toBeNull();
        });
        
        test('should return null for invalid date', () => {
            const date = parsePeremption('invalid');
            expect(date).toBeNull();
        });
    });
    
    describe('daysUntil', () => {
        test('should calculate days until future date', () => {
            const today = new Date();
            const futureDate = new Date(today);
            futureDate.setDate(today.getDate() + 10);
            
            const days = daysUntil(futureDate);
            expect(days).toBe(10);
        });
        
        test('should return negative for past date', () => {
            const today = new Date();
            const pastDate = new Date(today);
            pastDate.setDate(today.getDate() - 5);
            
            const days = daysUntil(pastDate);
            expect(days).toBe(-5);
        });
        
        test('should return 0 for today', () => {
            const today = new Date();
            const days = daysUntil(today);
            expect(days).toBe(0);
        });

        test('should return 0 even when target date has different time of day', () => {
            const todayAfternoon = new Date();
            todayAfternoon.setHours(23, 59, 59, 999);
            expect(daysUntil(todayAfternoon)).toBe(0);

            const todayMorning = new Date();
            todayMorning.setHours(1, 0, 0, 0);
            expect(daysUntil(todayMorning)).toBe(0);
        });
    });
    
    describe('todayFR', () => {
        test('should return date in DD/MM/YYYY format', () => {
            const dateStr = todayFR();
            expect(dateStr).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
        });
        
        test('should return current date', () => {
            const dateStr = todayFR();
            const now = new Date();
            const expected = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
            expect(dateStr).toBe(expected);
        });
    });
    
    describe('parseNombreFR', () => {
        test('should parse French number with comma', () => {
            expect(parseNombreFR('12,50')).toBe(12.5);
        });
        
        test('should parse French number with space thousands separator', () => {
            expect(parseNombreFR('1 234,56')).toBe(1234.56);
        });
        
        test('should parse French number with dot thousands separator', () => {
            expect(parseNombreFR('1.234,56')).toBe(1234.56);
        });
        
        test('should parse integer', () => {
            expect(parseNombreFR('100')).toBe(100);
        });

        test('should return 0 for null, empty or invalid strings', () => {
            expect(parseNombreFR(null)).toBe(0);
            expect(parseNombreFR('')).toBe(0);
            expect(parseNombreFR('abc')).toBe(0);
        });

        test('should handle already numeric inputs cleanly', () => {
            expect(parseNombreFR(42.5)).toBe(42.5);
            expect(parseNombreFR(0)).toBe(0);
        });
    });
    
    describe('round2', () => {
        test('should round to 2 decimal places', () => {
            expect(round2(10.12345)).toBe(10.12);
        });
        
        test('should round up correctly', () => {
            expect(round2(10.126)).toBe(10.13);
        });
        
        test('should handle integers', () => {
            expect(round2(10)).toBe(10);
        });
        
        test('should handle negative numbers', () => {
            expect(round2(-10.126)).toBe(-10.13);
        });
    });
    
    describe('round4', () => {
        test('should round to 4 decimal places', () => {
            expect(round4(10.123456)).toBe(10.1235);
        });
        
        test('should round up correctly', () => {
            expect(round4(10.12345)).toBe(10.1235);
        });
        
        test('should handle integers', () => {
            expect(round4(10)).toBe(10);
        });
        
        test('should preserve precision for CUMP calculations', () => {
            // Test case: 41.25€ / 10 = 4.125€
            expect(round4(41.25 / 10)).toBe(4.125);
        });
    });

    describe('parseBarcodes', () => {
        test('should parse empty or null input', () => {
            expect(parseBarcodes('')).toEqual([]);
            expect(parseBarcodes(null)).toEqual([]);
            expect(parseBarcodes(undefined)).toEqual([]);
        });

        test('should parse single barcode', () => {
            expect(parseBarcodes('123456')).toEqual(['123456']);
        });

        test('should parse comma-separated barcodes and trim whitespace', () => {
            expect(parseBarcodes('123456, 789012, 345678')).toEqual(['123456', '789012', '345678']);
        });

        test('should support semicolons and newlines as delimiters', () => {
            expect(parseBarcodes('111; 222\n333')).toEqual(['111', '222', '333']);
        });

        test('should deduplicate barcodes while preserving order', () => {
            expect(parseBarcodes('111, 222, 111, 333, 222')).toEqual(['111', '222', '333']);
        });

        test('should handle arrays of barcodes', () => {
            expect(parseBarcodes(['111', '222, 333', '111'])).toEqual(['111', '222', '333']);
        });
    });

    describe('formatBarcodes', () => {
        test('should format barcodes into comma-separated string', () => {
            expect(formatBarcodes(['111', '222'])).toBe('111, 222');
            expect(formatBarcodes('111, 222, 111')).toBe('111, 222');
            expect(formatBarcodes('')).toBe('');
        });
    });

    describe('mergeBarcodes', () => {
        test('should merge two sets of barcodes without duplicates', () => {
            expect(mergeBarcodes('111, 222', '222, 333')).toBe('111, 222, 333');
            expect(mergeBarcodes('', '333')).toBe('333');
            expect(mergeBarcodes('111', '')).toBe('111');
        });
    });

    describe('matchesBarcode', () => {
        test('should return true if code matches any barcode', () => {
            expect(matchesBarcode('111, 222, 333', '222')).toBe(true);
            expect(matchesBarcode('111, 222, 333', '111')).toBe(true);
            expect(matchesBarcode('111, 222, 333', '333')).toBe(true);
        });

        test('should be case-insensitive and ignore surrounding whitespace', () => {
            expect(matchesBarcode('ABC-123, DEF-456', 'abc-123')).toBe(true);
            expect(matchesBarcode('ABC-123, DEF-456', '  DEF-456  ')).toBe(true);
        });

        test('should return false if code does not match', () => {
            expect(matchesBarcode('111, 222', '999')).toBe(false);
            expect(matchesBarcode('', '111')).toBe(false);
            expect(matchesBarcode(null, '111')).toBe(false);
            expect(matchesBarcode('111', '')).toBe(false);
            expect(matchesBarcode('111', null)).toBe(false);
        });
    });

    describe('escapeHtml', () => {
        test('should escape special HTML characters', () => {
            expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
            expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
            expect(escapeHtml("it's a 'test'")).toBe("it&#039;s a &#039;test&#039;");
        });

        test('should handle null, undefined, and non-string inputs safely', () => {
            expect(escapeHtml(null)).toBe('');
            expect(escapeHtml(undefined)).toBe('');
            expect(escapeHtml('')).toBe('');
            expect(escapeHtml(123)).toBe('123');
            expect(escapeHtml(0)).toBe('0');
        });
    });
});
