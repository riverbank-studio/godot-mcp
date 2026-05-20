func set_collision_layer_bit(body: CollisionObject2D, layer: int, enabled: bool) -> void:
	var bit := 1 << (layer - 1)
	if enabled:
		body.collision_layer |= bit
	else:
		body.collision_layer &= ~bit

func set_collision_mask_bit(body: CollisionObject2D, layer: int, enabled: bool) -> void:
	var bit := 1 << (layer - 1)
	if enabled:
		body.collision_mask |= bit
	else:
		body.collision_mask &= ~bit
