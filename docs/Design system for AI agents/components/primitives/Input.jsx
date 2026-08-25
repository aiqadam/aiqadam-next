export function Input({
  label,
  type = 'text',
  placeholder,
  value,
  defaultValue,
  onChange,
  error,
  helperText,
  icon,
  disabled = false,
  required = false,
  className = '',
  id,
  ...props
}) {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {label && (
        <label className="label" htmlFor={inputId}>
          {label}
          {required && (
            <span style={{ color: 'var(--destructive)', marginLeft: 3 }} aria-hidden="true">*</span>
          )}
        </label>
      )}
      <div className={icon ? 'input-wrap' : undefined}>
        {icon}
        <input
          id={inputId}
          type={type}
          className={['input', error ? 'error' : '', className].filter(Boolean).join(' ')}
          placeholder={placeholder}
          value={value}
          defaultValue={defaultValue}
          onChange={onChange}
          disabled={disabled}
          required={required}
          aria-invalid={!!error}
          aria-describedby={error || helperText ? `${inputId}-helper` : undefined}
          {...props}
        />
      </div>
      {(error || helperText) && (
        <span id={`${inputId}-helper`} className={`helper${error ? ' error' : ''}`}>
          {error || helperText}
        </span>
      )}
    </div>
  );
}

export function Textarea({
  label,
  placeholder,
  value,
  defaultValue,
  onChange,
  error,
  helperText,
  disabled = false,
  required = false,
  rows = 4,
  className = '',
  id,
  ...props
}) {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {label && (
        <label className="label" htmlFor={inputId}>
          {label}
          {required && (
            <span style={{ color: 'var(--destructive)', marginLeft: 3 }} aria-hidden="true">*</span>
          )}
        </label>
      )}
      <textarea
        id={inputId}
        className={['textarea', error ? 'error' : '', className].filter(Boolean).join(' ')}
        placeholder={placeholder}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        disabled={disabled}
        rows={rows}
        aria-invalid={!!error}
        {...props}
      />
      {(error || helperText) && (
        <span className={`helper${error ? ' error' : ''}`}>{error || helperText}</span>
      )}
    </div>
  );
}
