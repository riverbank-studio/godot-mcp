## Top-level game manager (autoload singleton).
##
## Tracks score, active players, and wave number.  References player.gd and
## enemy.gd — deliberately exercises cross-file definition lookup.
class_name GameManager
extends Node

# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

## Emitted when the score changes.
signal score_changed(new_score: int)

## Emitted when a new wave begins.
signal wave_started(wave_number: int)

# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

var score: int = 0
var wave_number: int = 0

## All currently-alive Player instances.
var players: Array[Player] = []

## All currently-alive Enemy instances.
var enemies: Array[Enemy] = []

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

## Register a player with the manager.  Called from Player._ready().
func register_player(p: Player) -> void:
	if not players.has(p):
		players.append(p)
		p.about_to_despawn.connect(_on_player_despawned)


## Register an enemy with the manager.
func register_enemy(e: Enemy) -> void:
	if not enemies.has(e):
		enemies.append(e)
		e.about_to_despawn.connect(_on_enemy_despawned)


## Add points and emit score_changed.
func add_score(points: int) -> void:
	score += points
	score_changed.emit(score)


## Advance to the next wave.
func next_wave() -> void:
	wave_number += 1
	wave_started.emit(wave_number)


# ---------------------------------------------------------------------------
# Private callbacks
# ---------------------------------------------------------------------------

func _on_player_despawned(entity: Entity) -> void:
	players.erase(entity)


func _on_enemy_despawned(entity: Entity) -> void:
	enemies.erase(entity)
