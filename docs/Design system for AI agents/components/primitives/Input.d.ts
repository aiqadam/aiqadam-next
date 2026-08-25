export interface InputProps {
  label?: string;
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url' | 'number';
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Error message — shows in red below input and activates error ring */
  error?: string;
  /** Neutral helper text below input */
  helperText?: string;
  /** Leading icon (Lucide SVG element, 16px, rendered inside the input) */
  icon?: React.ReactNode;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  id?: string;
}

export interface TextareaProps {
  label?: string;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  error?: string;
  helperText?: string;
  disabled?: boolean;
  required?: boolean;
  rows?: number;
  className?: string;
  id?: string;
}
