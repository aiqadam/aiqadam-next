Use for any clickable action. Pick variant by intent — primary for the single most important CTA per view, secondary for alternatives, ghost/outline for low-weight actions, destructive for irreversible operations.

```jsx
// Primary CTA
<Button variant="primary">Register for event</Button>

// Secondary action
<Button variant="secondary">Save draft</Button>

// With leading icon (Lucide, 16px)
<Button variant="ghost" icon={<CalendarDays size={16} />}>Add to calendar</Button>

// Small destructive
<Button variant="destructive" size="sm">Withdraw</Button>

// Loading state
<Button variant="primary" loading>Saving…</Button>

// Icon-only (square)
<Button variant="ghost" iconOnly icon={<MoreHorizontal size={16} />} />
```

**Variants:** `primary` (brand teal fill) · `secondary` (muted bg + border) · `ghost` (transparent, hover bg) · `outline` (transparent, visible border) · `destructive` (red fill)

**Sizes:** `sm` 32px height · `default` 40px · `lg` 44px

**Notes:**
- Loading spinner uses `animation: aiq-spin` — add `@keyframes aiq-spin { to { transform: rotate(360deg); } }` to your global CSS if needed.
- Never use more than one `primary` button per viewport region.
- For icon-only buttons, always add an `aria-label` for accessibility.
