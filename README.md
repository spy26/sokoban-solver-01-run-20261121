# Sokoban Solver — Push-Optimal, Room by Room

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/spy26/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/spy26/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver built for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. Join make.fun with my referral link: https://make.fun/r/yqkj6dvt

## How it works

A level is a one-wide hallway with small rooms off it, one door each. A box
pushed out of a room can never come back, so each room is an independent
puzzle and the level optimum is the sum of the rooms' optima.

- **Room split** — the dead squares of the player's (hallway) row are cut
  out of the floor; each remaining part holding boxes is a room.
- **Push-optimal A\*** per room — a state is the boxes plus the player's
  reachable region (named by its lowest square); edges are single pushes.
- **Heuristic** — min-cost box-to-goal matching over precomputed walking
  distances (exact by permutation for up to 4 boxes). Each push moves one
  box one square, so it never overestimates: the first solved state popped
  is push-optimal.
- **Pruning** — dead squares (reverse-pull reachability from the goals) and
  frozen 2x2 blocks.
- **Stitching** — per-room push sequences are joined with shortest walks
  between doors; the other rooms' boxes stand as walls while one room is
  solved.

The solver is deterministic (fixed iteration orders and tie-breaks, no clock
or randomness) and solves all five practice levels at their optima
(13 / 16 / 29 / 47 / 60 pushes) in well under a second each.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `MAKEFUN_INPUT_DIR` (default `/input`) and
`MAKEFUN_OUTPUT_DIR` (default `/output`): for every instance id it reads
`<id>/level.txt` (XSB) and writes `<id>/solution.txt` with the move string
(`u`/`d`/`l`/`r`, one line). Node 22, no dependencies, no install step.

## License

MIT — see [LICENSE](LICENSE).
