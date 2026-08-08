import { tva, isWeb } from '@gluestack-ui/utils/nativewind-utils';
const baseStyle = isWeb
  ? 'font-sans tracking-sm bg-transparent border-0 box-border display-inline list-none margin-0 padding-0 position-relative text-start no-underline whitespace-pre-wrap word-wrap-break-word'
  : '';

export const headingStyle = tva({
  base: `text-typography-900 font-bold font-heading tracking-sm my-0 ${baseStyle}`,
  variants: {
    isTruncated: {
      true: 'truncate',
    },
    bold: {
      true: 'font-bold',
    },
    underline: {
      true: 'underline',
    },
    strikeThrough: {
      true: 'line-through',
    },
    sub: {
      true: 'text-xs',
    },
    italic: {
      true: 'italic',
    },
    highlight: {
      true: 'bg-yellow-500',
    },
    // ONE size vocabulary, shared with `textStyle`. `size="lg"` means the same
    // number of pixels on a <Heading> as it does on a <Text>.
    //
    // It used to be offset by one step (`3xl` -> `text-4xl`), which was not a
    // naming wart but a live rendering bug: TranslatableStatic and
    // TranslatableDynamic take ONE `size` prop and forward it to either <Text>
    // or <Heading> depending on `as`, so the identical `size="md"` rendered
    // 14px as text and 18px as heading at seven call sites. The `as any` casts
    // those two components carried existed only because the two size unions
    // disagreed; both are gone now.
    //
    // The offset was removed WITHOUT changing any rendered size: every heading
    // call site was shifted up one step in the same commit, and the
    // `heading-text-scale-parity` test below locks the two maps together.
    size: {
      '2xs': 'text-2xs',
      'xs': 'text-xs',
      'sm': 'text-sm',
      'md': 'text-base',
      'lg': 'text-lg',
      'xl': 'text-xl',
      '2xl': 'text-2xl',
      '3xl': 'text-3xl',
      '4xl': 'text-4xl',
      '5xl': 'text-5xl',
      '6xl': 'text-6xl',
    },
  },
});
