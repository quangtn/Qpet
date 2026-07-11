# Qmini theme generation notes

Generated with the built-in image generation tool, using
`qmini-style-reference.png` as the required identity reference. Sources were
rendered on flat `#00ff00`, converted to transparent PNGs with the Imagegen
chroma-key helper, and downscaled to 256×256 with Lanczos resampling.

## Master prompt

Create canonical Qmini as a compact front-facing desktop-pet sprite: squat
warm-stone body, three-piece tuft, oversized warm-brown glasses, cyan headset
and microphone, cyan Q chest emblem, tiny feet, and short side arms. Use smooth
contemporary comic illustration, thick espresso outlines, simplified two-tone
shading, minimal texture, generous square padding, and details that remain
clear at 90 pixels. Use a uniform `#00ff00` background with no shadow, props,
extra text, watermark, pixel art, or 3D rendering.

## State edit prompts

Every state used the approved master plus the original Qmini reference and
required identical proportions, palette, outline, headset, glasses, emblem,
tuft, scale, and padding.

- `sleeping`: closed eyes, peaceful smile, relaxed arms, settled posture, dim headset.
- `working`: focused eyes, confident smile, slight forward energy, active cyan headset.
- `awaiting-input`: attentive eyes, one raised hand, curious expression.
- `success`: happy crescent eyes, broad smile, compact thumbs-up.
- `error`: worried eyebrows, downturned mouth, slumped posture, inactive headset.
- `awaiting-approval`: attentive eyes, hands together in a patient waiting pose.
- `notification`: bright eyes, friendly smile, one waving arm.
- `idle`: the approved neutral master.

All state prompts prohibited background texture, shadows, extra objects, green
inside the subject, identity drift, cropping, and fragile small details.
