## Player-controlled entity.
##
## Inherits from Entity and adds movement, health, and an inventory.
## The jump() method is the primary symbol used in the definition / reference
## fixture labels.
class_name Player
extends Entity

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

## Maximum speed in pixels per second.
const MAX_SPEED: float = 300.0

## Gravity multiplier applied while airborne.
const GRAVITY_SCALE: float = 2.5

# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

## Current health.  Clamped to [0, max_health] by take_damage().
var health: int = 100

## Upper bound on health.
@export var max_health: int = 100

## Simple inventory: item_name → quantity.
var inventory: Dictionary = {}

# ---------------------------------------------------------------------------
# @onready references
# ---------------------------------------------------------------------------

@onready var _sprite: Sprite2D = $Sprite2D
@onready var _anim: AnimationPlayer = $AnimationPlayer

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	super._ready()
	health = max_health


func _physics_process(delta: float) -> void:
	_apply_gravity(delta)


# ---------------------------------------------------------------------------
# Movement
# ---------------------------------------------------------------------------

## Apply a vertical velocity impulse to make the player jump.
func jump(impulse: float = 400.0) -> void:
	if is_on_floor():
		velocity.y = -impulse


## Apply gravity, scaled by GRAVITY_SCALE, each physics tick.
func _apply_gravity(delta: float) -> void:
	if not is_on_floor():
		velocity.y += GRAVITY_SCALE * ProjectSettings.get_setting(
			"physics/2d/default_gravity"
		) * delta


# ---------------------------------------------------------------------------
# Combat
# ---------------------------------------------------------------------------

## Reduce health by `amount`; emit `about_to_despawn` and die if health hits 0.
func take_damage(amount: int) -> void:
	health = clampi(health - amount, 0, max_health)
	if health == 0:
		despawn()


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

## Add `qty` units of `item` to the inventory.
func pick_up(item: String, qty: int = 1) -> void:
	inventory[item] = inventory.get(item, 0) + qty


## Remove `qty` units of `item`.  Returns the actual amount removed.
func consume(item: String, qty: int = 1) -> int:
	var have: int = inventory.get(item, 0)
	var removed: int = mini(have, qty)
	if removed > 0:
		inventory[item] = have - removed
	return removed
