extends CharacterBody2D

func _physics_process(_delta: float) -> void:
	move_and_slide()
	sync_position.rpc(global_position)

func set_health(hp: int) -> void:
	pass

func broadcast_health(peer_id: int, hp: int) -> void:
	set_health.rpc_id(peer_id, hp)

@rpc("any_peer", "call_local")
func sync_position(pos: Vector2) -> void:
	global_position = pos
