extends CharacterBody2D

func _physics_process(_delta: float) -> void:
	move_and_slide()
	rpc("sync_position", global_position)  # bug: Godot 3 syntax

func set_health(hp: int) -> void:
	pass

func broadcast_health(peer_id: int, hp: int) -> void:
	rpc_id(peer_id, "set_health", hp)  # bug: Godot 3 syntax

@rpc("any_peer", "call_local")
func sync_position(pos: Vector2) -> void:
	global_position = pos
