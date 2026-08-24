with open('ids.csv','w') as f:
    for i in range(100):
        if i< 10:
            f.write(f'P0{i},\n')
        else:
            f.write(f'P{i},\n')
