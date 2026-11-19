# Model and sound credits

Every 3D model and sound in the playground is recorded here with its source
and licence.

## Aircraft

| Asset | Source | Licence |
| --- | --- | --- |
| "Rokh 141" light airplane | Built in code: `src/components/playground/three/airplane-model.ts` (three.js primitives, no mesh file) | Part of this project |
| "Shahin 141" race plane | Built in code: `src/components/playground/three/racer-model.ts` (three.js primitives, no mesh file) | Part of this project |
| "F-14 Tomcat - Fighter Jet - Free" (`f-14_tomcat_-_fighter_jet_-_free.glb`), free-flight jet | [bohmerang on Sketchfab](https://sketchfab.com/3d-models/f-14-tomcat-fighter-jet-free-497f77c311b5411d9b567d8707a81c33) | [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/) — **non-commercial: internal playground use only, never in the public site.** Used unmodified (loaded as is; only placed and scaled in code) |
| "Rescue helicopter" (`rescue_helicopter.glb`), the playground's "Simorgh 141" helicopter | [Ghosttisti on Sketchfab](https://sketchfab.com/3d-models/rescue-helicopter-bee975ff45124778828c661f21d0a14f) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). Loaded as is; on load the main rotor's triangles are split into their own mesh so it can spin (`src/components/playground/three/heli-model.ts`) |
| Race gates, smoke, gate bursts | Built in code: `src/components/playground/three/aircraft-layer.ts` (three.js primitives and a small point shader) | Part of this project |

The Rokh 141 and the Shahin 141 are original designs in the 141 livery. They
are not models of any real manufacturer's aircraft; only their flight
performance follows published figures for their classes (four-seat
single-engine trainer; single-seat unlimited aerobatic monoplane).

The playground beyond the drone view is internal: the F-14 file must not ship
with any public build. If the drone view goes public, remove it from that build.

## Sound

| Sound | Source | Licence |
| --- | --- | --- |
| Engine, wind, stall horn, race cues (countdown, gate, missed gate, finish) | Synthesised at run time with the Web Audio API: `src/components/playground/flight-audio.ts` (oscillators and filtered noise, no samples) | Part of this project |

## Data

Flight-model numbers (stability and control derivatives) follow the published
values for the class in J. Roskam, *Airplane Flight Dynamics and Automatic
Flight Controls*; the stall blend follows Beard and McLain, *Small Unmanned
Aircraft*. Race courses are laid out on the 141 DEM (Copernicus DEM) by
`scripts/design-courses.mts`. Runways come from the 141 basemap's `aeroway` layer (OpenMapTiles
schema, © OpenStreetMap contributors).
