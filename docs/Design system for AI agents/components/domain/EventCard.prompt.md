The central domain pattern. Use for any list of events — homepage grid, profile history, chapter archive. Pass `onClick` to make it navigable.

```jsx
<EventCard
  event={{
    month: 'May', day: '22', weekday: 'Fri',
    status: 'upcoming',
    title: 'AI Qadam #4 · LLM Engineering in Production',
    description: 'Practitioner stories from teams running LLM systems in production.',
    time: '18:30', location: 'Tashkent · IT Park',
    tags: ['#LLM', '#MLOps', '#Prompt-Engineering'],
    speakers: [{ initials: 'AM' }, { initials: 'BR' }, { initials: 'VT' }],
    going: 142,
  }}
  onClick={() => navigate('/events/ai-qadam-4')}
/>

// Live state
<EventCard event={{ status: 'live', liveTime: '14:00 → 18:00 GMT+5', watching: 89, ...rest }} />

// Past state (renders at 0.7 opacity)
<EventCard event={{ status: 'past', going: 178, ...rest }} />
```

**Status appearance:**
- `upcoming` — teal badge, full opacity
- `live` — green pulsing dot + LIVE badge with time range
- `past` — muted grey badge, 70% opacity
- `online` — teal ONLINE badge, Zoom/URL in location
- `hackathon` — purple HACKATHON badge
