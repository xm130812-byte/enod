declare module 'mammoth' {
  export interface MammothImage {
    read(): Promise<Buffer>;
    contentType: string;
    altText?: string;
  }

  export interface MammothMessage {
    type: 'warning' | 'error';
    message: string;
  }

  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }

  export interface ConversionOptions {
    convertImage?: unknown;
    styleMap?: string[];
  }

  export type Input = { buffer: Buffer } | { path: string };

  export function convertToHtml(input: Input, options?: ConversionOptions): Promise<MammothResult>;
  export function extractRawText(input: Input): Promise<MammothResult>;

  export const images: {
    imgElement(convert: (image: MammothImage) => Promise<Record<string, string>>): unknown;
  };
}
