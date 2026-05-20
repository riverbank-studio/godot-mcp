func snap_to_grid(world_position: Vector2, cell_size: int) -> Vector2:
	return snapped(world_position, Vector2(cell_size, cell_size))

func world_to_cell(world_position: Vector2, cell_size: int) -> Vector2i:
	return Vector2i(
		int(floor(world_position.x / cell_size)),
		int(floor(world_position.y / cell_size))
	)
